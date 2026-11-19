# Offline package CLI

`quarry` is deliberately offline. It does not start a server, call a registry, invoke Git, or upload a capture. It creates a normal directory that a user can inspect and commit to any Git remote.

```powershell
cargo run --manifest-path cli/Cargo.toml -- package create capture.json out/demo-card demo/card
cargo run --manifest-path cli/Cargo.toml -- package validate out/demo-card
```

The package contains `quarry.json` and `captures/<id>/capture.json`. The manifest records SHA-256 hashes and `NOASSERTION` until the user supplies a license. A Capture may include an optional PNG/JPEG viewport screenshot data URL (up to 10 MB) to preserve canvas and other pixels outside its HTML fragment. The validator rejects malformed or oversized screenshots as well as traversal, absolute paths, symlinks, duplicate files, size mismatches, and corrupted hashes.

For a selected `<canvas>`, look for `canvasBitmap.dataUrl` in the packaged capture. It holds one PNG frame of that canvas, up to 5,000,000 characters including the data URL prefix. `canvasBitmap.width` and `height` give its intrinsic dimensions in pixels. A capture can include this frame independently of a viewport screenshot. If the browser cannot read the frame, `notes` explains why `canvasBitmap` is absent.
