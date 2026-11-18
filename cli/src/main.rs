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
    for field in ["name", "sourceUrl", "capturedAt", "selector", "html", "css"] {
        if !value[field].is_string() {
            bail!("capture field {field:?} must be a string")
        }
    }
    let url = value["sourceUrl"].as_str().unwrap_or_default();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("capture sourceUrl must use http or https")
    }
    for field in ["scripts", "events"] {
        if !value[field].is_array() {
            bail!("capture field {field:?} must be an array")
        }
    }
    for field in ["viewport", "bounds"] {
        if !value[field].is_object() {
            bail!("capture field {field:?} must be an object")
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
        .filter(|name| !name.is_empty() && name.len() <= 200)
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
    let files = manifest["files"]
        .as_array()
        .ok_or_else(|| anyhow!("package files must be an array"))?;
    if files.is_empty() {
        bail!("package must contain at least one payload file")
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
}
