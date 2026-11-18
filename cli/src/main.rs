use std::{
    collections::HashSet,
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process,
};

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_CAPTURE_BYTES: u64 = 12 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    id: String,
    name: String,
    kind: &'static str,
    tags: Vec<String>,
    created_at: String,
    license: &'static str,
    source_url: String,
    files: Vec<ManifestFile>,
    entrypoints: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFile {
    path: String,
    sha256: String,
    size: u64,
    media_type: &'static str,
}

fn main() {
    if let Err(error) = run(env::args().skip(1)) {
        eprintln!("error: {error:#}");
        process::exit(1);
    }
}

fn run(mut args: impl Iterator<Item = String>) -> Result<()> {
    let Some(command) = args.next() else {
        print_help();
        bail!("missing command")
    };
    if command != "package" {
        print_help();
        bail!("unknown command {command:?}")
    }
    let Some(action) = args.next() else {
        print_help();
        bail!("missing package action")
    };

    match action.as_str() {
        "create" => {
            let input = next_path(&mut args, "capture.json")?;
            let output = next_path(&mut args, "out-dir")?;
            let id = args.next().ok_or_else(|| anyhow!("missing package id"))?;
            ensure_no_extra_args(args)?;
            let path = create_capture_package(&input, &output, &id)?;
            println!("Created package at {}", path.display());
            Ok(())
        }
        "validate" => {
            let package_dir = next_path(&mut args, "package-dir")?;
            ensure_no_extra_args(args)?;
            let id = validate_package(&package_dir)?;
            println!("Valid package {id} at {}", package_dir.display());
            Ok(())
        }
        _ => {
            print_help();
            bail!("unknown package action {action:?}")
        }
    }
}

fn next_path(args: &mut impl Iterator<Item = String>, label: &str) -> Result<PathBuf> {
    args.next().map(PathBuf::from).ok_or_else(|| anyhow!("missing {label}"))
}

fn ensure_no_extra_args(mut args: impl Iterator<Item = String>) -> Result<()> {
    if args.next().is_some() {
        bail!("too many arguments")
    }
    Ok(())
}

fn print_help() {
    eprintln!(
        "Usage:\n  quarry package create <capture.json> <out-dir> <id>\n  quarry package validate <package-dir>\n\nRun with Cargo: cargo run --manifest-path cli/Cargo.toml -- package ..."
    );
}

fn create_capture_package(input: &Path, output: &Path, id: &str) -> Result<PathBuf> {
    validate_package_id(id)?;
    let bytes = fs::read(input).with_context(|| format!("read capture {}", input.display()))?;
    if bytes.len() as u64 > MAX_CAPTURE_BYTES {
        bail!("capture exceeds the 12 MiB size limit")
    }
    let mut capture: Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parse capture JSON {}", input.display()))?;
    validate_capture(&capture)?;
    capture["id"] = Value::String(id.to_owned());
    let capture_bytes = serde_json::to_vec_pretty(&capture)?;

    let relative_file = format!("captures/{id}/capture.json");
    validate_relative_path(&relative_file)?;
    let name = capture["name"].as_str().unwrap_or_default().to_owned();
    let tags = capture["tags"].as_array().map_or_else(Vec::new, |values| {
        values.iter().filter_map(Value::as_str).map(str::to_owned).collect()
    });
    let manifest = Manifest {
        schema_version: 1,
        id: id.to_owned(),
        name,
        kind: "capture",
        tags,
        created_at: capture["capturedAt"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| Utc::now().to_rfc3339()),
        license: "NOASSERTION",
        source_url: capture["sourceUrl"].as_str().unwrap_or_default().to_owned(),
        files: vec![ManifestFile {
            path: relative_file.clone(),
            sha256: sha256_hex(&capture_bytes),
            size: capture_bytes.len() as u64,
            media_type: "application/json",
        }],
        entrypoints: vec![relative_file.clone()],
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;

    let output = absolute_destination(output)?;
    if output.exists() {
        bail!("output directory already exists: {}", output.display())
    }
    let parent = output.parent().ok_or_else(|| anyhow!("output path has no parent"))?;
    let stage = parent.join(format!(".uiquarry-package-{}", Uuid::new_v4()));
    fs::create_dir(&stage).with_context(|| format!("create staging directory {}", stage.display()))?;
    let result = (|| -> Result<()> {
        let capture_path = join_safe_relative(&stage, &validate_relative_path(&relative_file)?)?;
        fs::create_dir_all(capture_path.parent().expect("capture path has parent"))?;
        write_new_file(&capture_path, &capture_bytes)?;
        write_new_file(&stage.join("quarry.json"), &manifest_bytes)?;
        validate_package(&stage)?;
        fs::rename(&stage, &output).with_context(|| format!("publish package to {}", output.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result?;
    Ok(output)
}

fn validate_capture(value: &Value) -> Result<()> {
    if !value.is_object() || value["schemaVersion"].as_u64() != Some(1) {
        bail!("capture must be a JSON object with schemaVersion 1")
    }
    for (field, max_chars) in [
        ("name", 200),
        ("sourceUrl", 2048),
        ("capturedAt", 80),
        ("selector", 2048),
        ("html", 2_000_000),
        ("css", 1_000_000),
    ] {
        if !value[field].is_string() {
            bail!("capture field {field:?} must be a string")
        }
        let content = value[field].as_str().unwrap_or_default();
        if content.chars().count() > max_chars || (field == "name" && content.trim().is_empty()) {
            bail!("capture field {field:?} is empty or exceeds its character limit")
        }
    }
    let url = value["sourceUrl"].as_str().unwrap_or_default();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("capture sourceUrl must use http or https")
    }
    if let Some(tags) = value.get("tags") {
        let tags = tags
            .as_array()
            .ok_or_else(|| anyhow!("capture tags must be an array"))?;
        if tags.len() > 50 {
            bail!("capture may contain at most 50 tags")
        }
        let mut seen_tags = HashSet::new();
        for tag in tags {
            let text = tag
                .as_str()
                .filter(|text| !text.is_empty() && text.chars().count() <= 64)
                .ok_or_else(|| anyhow!("capture tags must be non-empty strings of at most 64 characters"))?;
            if !seen_tags.insert(text) {
                bail!("capture tags must be unique")
            }
        }
    }

    let captured_at = value["capturedAt"].as_str().unwrap_or_default();
    if chrono::DateTime::parse_from_rfc3339(captured_at).is_err() {
        bail!("capture capturedAt must be an RFC 3339 timestamp")
    }

    if let Some(id) = value.get("id") {
        let id = id.as_str().ok_or_else(|| anyhow!("capture id must be a string"))?;
        validate_package_id(id)?;
    }

    let scripts = value["scripts"]
        .as_array()
        .ok_or_else(|| anyhow!("capture scripts must be an array"))?;
    if scripts.len() > 100 {
        bail!("capture may contain at most 100 script references")
    }
    for script in scripts {
        let kind = script["kind"].as_str().unwrap_or_default();
        if !matches!(kind, "inline" | "external" | "module" | "reference")
            || script["source"]
                .as_str()
                .is_none_or(|source| source.chars().count() > 200_000)
            || script["relation"]
                .as_str()
                .is_none_or(|relation| relation.chars().count() > 512)
        {
            bail!("capture script references need a supported kind, source, and relation")
        }
    }
    let events = value["events"]
        .as_array()
        .ok_or_else(|| anyhow!("capture events must be an array"))?;
    if events.len() > 1000 {
        bail!("capture may contain at most 1000 interaction samples")
    }
    for event in events {
        if event["type"].as_str().is_none_or(|text| text.chars().count() > 64)
            || event["target"].as_str().is_none_or(|text| text.chars().count() > 2048)
            || event["atMs"]
                .as_f64()
                .is_none_or(|number| !number.is_finite() || number < 0.0)
        {
            bail!("capture events require a type, target, and non-negative atMs")
        }
    }

    let viewport = &value["viewport"];
    if viewport["width"].as_f64().is_none_or(|n| !n.is_finite() || n < 0.0)
        || viewport["height"].as_f64().is_none_or(|n| !n.is_finite() || n < 0.0)
        || viewport
            .get("deviceScaleFactor")
            .is_some_and(|v| v.as_f64().is_none_or(|n| !n.is_finite() || n <= 0.0))
    {
        bail!("capture viewport needs non-negative width and height")
    }
    let bounds = &value["bounds"];
    for field in ["x", "y"] {
        if bounds[field].as_f64().is_none_or(|n| !n.is_finite()) {
            bail!("capture bounds needs numeric {field}")
        }
    }
    for field in ["width", "height"] {
        if bounds[field].as_f64().is_none_or(|n| !n.is_finite() || n < 0.0) {
            bail!("capture bounds needs non-negative {field}")
        }
    }
    Ok(())
}

fn validate_package(package_dir: &Path) -> Result<String> {
    let root =
        fs::canonicalize(package_dir).with_context(|| format!("open package directory {}", package_dir.display()))?;
    if !root.is_dir() {
        bail!("package path is not a directory")
    }
    let manifest_path = root.join("quarry.json");
    if fs::symlink_metadata(&manifest_path)?.file_type().is_symlink() {
        bail!("quarry.json must not be a symlink")
    }
    let manifest: Value =
        serde_json::from_slice(&fs::read(&manifest_path).context("read quarry.json")?).context("parse quarry.json")?;
    if manifest["schemaVersion"].as_u64() != Some(1) {
        bail!("package schemaVersion must be 1")
    }
    let id = manifest["id"]
        .as_str()
        .ok_or_else(|| anyhow!("package id is missing"))?;
    validate_package_id(id)?;
    if manifest["name"]
        .as_str()
        .filter(|name| !name.trim().is_empty() && name.chars().count() <= 200)
        .is_none()
    {
        bail!("package name must be a non-empty string no longer than 200 bytes")
    }
    let kind = manifest["kind"]
        .as_str()
        .ok_or_else(|| anyhow!("package kind is missing"))?;
    if !matches!(kind, "capture" | "design" | "component") {
        bail!("package kind must be capture, design, or component")
    }
    for field in ["license", "createdAt"] {
        if manifest[field].as_str().filter(|value| !value.is_empty()).is_none() {
            bail!("package {field} must be a non-empty string")
        }
    }
    if chrono::DateTime::parse_from_rfc3339(manifest["createdAt"].as_str().unwrap_or_default()).is_err() {
        bail!("package createdAt must be an RFC 3339 timestamp")
    }
    let files = manifest["files"]
        .as_array()
        .ok_or_else(|| anyhow!("package files must be an array"))?;
    if files.is_empty() || files.len() > 10_000 {
        bail!("package must contain between 1 and 10000 payload files")
    }
    let mut seen = HashSet::with_capacity(files.len());
    for entry in files {
        let path = entry["path"]
            .as_str()
            .ok_or_else(|| anyhow!("file path must be a string"))?;
        let relative = validate_relative_path(path)?;
        if !seen.insert(path.to_lowercase()) {
            bail!("duplicate package file path: {path}")
        }
        if path == "quarry.json" {
            bail!("quarry.json must not be listed as a payload")
        }
        let hash = entry["sha256"]
            .as_str()
            .ok_or_else(|| anyhow!("file sha256 must be a string"))?;
        if !is_sha256(hash) {
            bail!("file sha256 must be 64 lowercase hexadecimal characters")
        }
        let size = entry["size"]
            .as_u64()
            .ok_or_else(|| anyhow!("file size must be a non-negative integer"))?;
        let file_path = join_safe_relative(&root, &relative)?;
        reject_symlink_components(&root, &relative)?;
        let canonical = fs::canonicalize(&file_path).with_context(|| format!("open package file {path}"))?;
        if !canonical.starts_with(&root) {
            bail!("package file escapes its root: {path}")
        }
        let metadata = fs::metadata(&canonical)?;
        if !metadata.is_file() {
            bail!("package entry is not a regular file: {path}")
        }
        if metadata.len() != size {
            bail!("file size mismatch for {path}")
        }
        if sha256_file(&canonical)? != hash {
            bail!("SHA-256 mismatch for {path}")
        }
    }

    if let Some(entrypoints) = manifest.get("entrypoints") {
        let values = entrypoints
            .as_array()
            .ok_or_else(|| anyhow!("entrypoints must be an array"))?;
        let listed: HashSet<&str> = values.iter().filter_map(Value::as_str).collect();
        if listed.len() != values.len() || listed.iter().any(|path| !seen.contains(&path.to_lowercase())) {
            bail!("each entrypoint must be a unique path listed in package files")
        }
    }

    match kind {
        "capture" => {
            let expected = format!("captures/{id}/capture.json");
            if !seen.contains(&expected.to_lowercase()) {
                bail!("capture package is missing {expected}")
            }
            let capture_path = join_safe_relative(&root, &validate_relative_path(&expected)?)?;
            let capture: Value = serde_json::from_slice(&fs::read(capture_path)?)?;
            validate_capture(&capture).context("invalid packaged capture")?;
            if capture["id"].as_str() != Some(id) {
                bail!("capture id must match package id")
            }
        }
        "design" => {
            let expected = format!("designs/{id}/design.json");
            if !seen.contains(&expected.to_lowercase()) {
                bail!("design package is missing {expected}")
            }
            let design_path = join_safe_relative(&root, &validate_relative_path(&expected)?)?;
            let design: Value = serde_json::from_slice(&fs::read(design_path)?)?;
            if design["schemaVersion"].as_u64() != Some(1)
                || design["root"].as_object().is_none()
                || design["tokens"].as_object().is_none()
                || design["assets"].as_array().is_none()
            {
                bail!("design.json must contain a v1 root, tokens, and assets")
            }
        }
        "component" => {}
        _ => unreachable!("kind checked above"),
    }
    Ok(id.to_owned())
}

fn validate_package_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 {
        bail!("package id must contain 1 to 128 bytes")
    }
    for segment in id.split('/') {
        if segment.is_empty()
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte))
            || !segment.as_bytes()[0].is_ascii_lowercase() && !segment.as_bytes()[0].is_ascii_digit()
        {
            bail!("package id must use lowercase ASCII letters, digits, '.', '_' or '-' in slash-separated segments")
        }
        let lower = segment.to_ascii_lowercase();
        let base = lower.split('.').next().unwrap_or_default();
        if segment.ends_with('.')
            || matches!(base, "con" | "prn" | "aux" | "nul")
            || ["com", "lpt"].iter().any(|prefix| {
                base.strip_prefix(prefix)
                    .is_some_and(|suffix| suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_digit() && suffix != "0")
            })
        {
            bail!("package id contains a Windows-reserved path segment")
        }
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<PathBuf> {
    if path.is_empty()
        || path.len() > 512
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains(':')
        || path.chars().any(char::is_control)
    {
        bail!("package path is not a canonical safe relative path: {path:?}")
    }
    let mut relative = PathBuf::new();
    for segment in path.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.ends_with('.')
            || segment.ends_with(' ')
            || is_windows_device_name(segment)
        {
            bail!("package path is not a canonical safe relative path: {path:?}")
        }
        relative.push(segment);
    }
    if relative.is_absolute() || relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        bail!("package path is not a canonical safe relative path: {path:?}")
    }
    Ok(relative)
}

fn is_windows_device_name(segment: &str) -> bool {
    let base = segment.split('.').next().unwrap_or_default().to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0')
}

fn join_safe_relative(root: &Path, relative: &Path) -> Result<PathBuf> {
    if relative.is_absolute() || relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        bail!("refusing to join unsafe package path")
    }
    Ok(root.join(relative))
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<()> {
    let mut current = root.to_owned();
    for part in relative.components() {
        let Component::Normal(name) = part else {
            bail!("refusing unsafe package path")
        };
        current.push(name);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            bail!("package path must not contain symlinks: {}", current.display())
        }
    }
    Ok(())
}

fn absolute_destination(path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("output directory needs a final path component"))?;
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    Ok(fs::canonicalize(parent)?.join(name))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn capture() -> Value {
        json!({
            "schemaVersion": 1, "name": "Example card", "tags": ["card"],
            "sourceUrl": "https://example.com/", "capturedAt": "2026-11-19T00:00:00Z",
            "selector": "main > .card", "html": "<article class=\"card\">Hello</article>",
            "css": ".card{padding:16px}", "scripts": [], "events": [],
            "viewport": {"width": 1280, "height": 720},
            "bounds": {"x": 10, "y": 20, "width": 200, "height": 80}
        })
    }

    fn write_capture(dir: &Path) -> PathBuf {
        let path = dir.join("input.json");
        fs::write(&path, serde_json::to_vec(&capture()).unwrap()).unwrap();
        path
    }

    #[test]
    fn creates_capture_package_with_no_assertion_license_and_valid_hashes() {
        let dir = tempdir().unwrap();
        let input = write_capture(dir.path());
        let package = dir.path().join("published");
        create_capture_package(&input, &package, "demo/card").unwrap();
        assert_eq!(validate_package(&package).unwrap(), "demo/card");
        let manifest: Value = serde_json::from_slice(&fs::read(package.join("quarry.json")).unwrap()).unwrap();
        assert_eq!(manifest["license"], "NOASSERTION");
        assert_eq!(manifest["files"][0]["path"], "captures/demo/card/capture.json");
        assert_eq!(manifest["files"][0]["sha256"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn does_not_overwrite_an_existing_directory() {
        let dir = tempdir().unwrap();
        let input = write_capture(dir.path());
        let package = dir.path().join("published");
        fs::create_dir(&package).unwrap();
        fs::write(package.join("keep.txt"), "keep").unwrap();
        assert!(create_capture_package(&input, &package, "demo/card").is_err());
        assert_eq!(fs::read_to_string(package.join("keep.txt")).unwrap(), "keep");
    }

    #[test]
    fn rejects_traversal_ids_and_unsafe_manifest_paths() {
        let dir = tempdir().unwrap();
        let input = write_capture(dir.path());
        assert!(create_capture_package(&input, &dir.path().join("out"), "../outside").is_err());
        for id in ["con", "demo/nul", "demo/com1", "demo/card."] {
            assert!(
                create_capture_package(&input, &dir.path().join(format!("out-{}", id.replace('/', "-"))), id).is_err()
            );
        }
        for path in ["../../outside", "C:/outside", "captures\\demo\\file.json", "a//b"] {
            assert!(validate_relative_path(path).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn detects_a_corrupted_payload() {
        let dir = tempdir().unwrap();
        let input = write_capture(dir.path());
        let package = dir.path().join("published");
        create_capture_package(&input, &package, "demo/card").unwrap();
        let file = package.join("captures/demo/card/capture.json");
        OpenOptions::new()
            .append(true)
            .open(file)
            .unwrap()
            .write_all(b" ")
            .unwrap();
        let error = validate_package(&package).unwrap_err().to_string();
        assert!(error.contains("file size mismatch") || error.contains("SHA-256 mismatch"));
    }

    #[test]
    fn rejects_a_manifest_path_that_escapes_through_a_symlink() {
        let dir = tempdir().unwrap();
        let package = dir.path().join("package");
        fs::create_dir_all(package.join("assets")).unwrap();
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, package.join("assets/outside.txt")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, package.join("assets/outside.txt")).unwrap();
        let manifest = json!({
            "schemaVersion": 1, "id": "demo/component", "name": "Component", "kind": "component",
            "license": "MIT", "createdAt": "2026-11-19T00:00:00Z",
            "files": [{"path": "assets/outside.txt", "sha256": sha256_hex(b"outside"), "size": 7}]
        });
        fs::write(package.join("quarry.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(validate_package(&package).unwrap_err().to_string().contains("symlink"));
    }

    #[test]
    fn preserves_unicode_names_and_emits_camel_case_media_type() {
        let dir = tempdir().unwrap();
        let input = write_capture(dir.path());
        let mut value: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
        value["name"] = json!("构石卡片组件");
        fs::write(&input, serde_json::to_vec(&value).unwrap()).unwrap();
        let package = dir.path().join("published");
        create_capture_package(&input, &package, "demo/card").unwrap();
        let manifest: Value = serde_json::from_slice(&fs::read(package.join("quarry.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], "构石卡片组件");
        assert_eq!(manifest["files"][0]["mediaType"], "application/json");
        assert!(manifest["files"][0].get("media_type").is_none());
    }

    #[test]
    fn rejects_entrypoints_not_covered_by_payload_hashes() {
        let dir = tempdir().unwrap();
        let package = dir.path().join("package");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("index.js"), "export {};").unwrap();
        let body = b"export {};";
        let manifest = json!({
            "schemaVersion": 1, "id": "demo/component", "name": "Component", "kind": "component",
            "license": "MIT", "createdAt": "2026-11-19T00:00:00Z",
            "files": [{"path": "index.js", "sha256": sha256_hex(body), "size": body.len()}],
            "entrypoints": ["missing.js"]
        });
        fs::write(package.join("quarry.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(validate_package(&package)
            .unwrap_err()
            .to_string()
            .contains("entrypoint"));
    }

    #[test]
    fn rejects_invalid_capture_dimensions_and_timestamp() {
        let mut value = capture();
        value["capturedAt"] = json!("yesterday");
        assert!(validate_capture(&value).unwrap_err().to_string().contains("capturedAt"));

        value = capture();
        value["bounds"]["width"] = json!(-1);
        assert!(validate_capture(&value).unwrap_err().to_string().contains("width"));
    }

    #[test]
    fn accepts_capture_without_optional_tags() {
        let mut value = capture();
        value.as_object_mut().unwrap().remove("tags");
        assert!(validate_capture(&value).is_ok());
    }
}
