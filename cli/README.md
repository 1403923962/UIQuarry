# Offline package CLI

`quarry` is deliberately offline. It does not start a server, call a registry, invoke Git, or upload a capture. It creates a normal directory that a user can inspect and commit to any Git remote.

```powershell
cargo run --manifest-path cli/Cargo.toml -- package create capture.json out/demo-card demo/card
cargo run --manifest-path cli/Cargo.toml -- package validate out/demo-card
```

The package contains `quarry.json` and `captures/<id>/capture.json`. The manifest records SHA-256 hashes and `NOASSERTION` until the user supplies a license. The validator rejects traversal, absolute paths, symlinks, duplicate files, size mismatches, and corrupted hashes.
