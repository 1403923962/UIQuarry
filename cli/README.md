# Offline package CLI

`quarry` is deliberately offline. It does not start a server, call a registry, invoke Git, or upload a capture. It creates a normal directory that a user can inspect and commit to any Git remote.

```powershell
cargo run --manifest-path cli/Cargo.toml -- package create capture.json out/demo-card demo/card
cargo run --manifest-path cli/Cargo.toml -- package validate out/demo-card
```

The package contains `quarry.json` and `captures/<id>/capture.json`. The manifest records SHA-256 hashes and `NOASSERTION` until the user supplies a license. A Capture may include an optional PNG/JPEG viewport screenshot data URL (up to 10 MB) to preserve canvas and other pixels outside its HTML fragment. The validator rejects malformed or oversized screenshots as well as traversal, absolute paths, symlinks, duplicate files, size mismatches, and corrupted hashes.

For a selected `<canvas>`, look for `canvasBitmap.dataUrl` in the packaged capture. It holds one PNG frame of that canvas, up to 5,000,000 characters including the data URL prefix. `canvasBitmap.width` and `height` give its intrinsic dimensions in pixels. A capture can include this frame independently of a viewport screenshot. If the browser cannot read the frame, `notes` explains why `canvasBitmap` is absent.

`compositeBitmap` holds a JPEG crop of the visible tab at the selected element's bounds, including other layers visible there. `canvasRecording` holds an optional WebM clip of the selected canvas, with its measured duration in milliseconds (1–6,000). Each data URL is limited to 3,000,000 characters, including its prefix. Neither field contains animation source code. As before, the complete input Capture JSON must fit within 12 MiB.

The optional `animations` array stores bounded Web Animations API observations for selected elements: at most 32 animations, 32 keyframes per animation, 24 safe CSS properties per keyframe, and 262,144 serialized bytes total. The validator rejects unknown fields, custom or unsafe CSS property names, URL-bearing values, invalid timing data, and over-limit records. It records values visible at capture time; it does not contain JavaScript or promise that the original animation can be replayed.

The optional `animations` array stores bounded Web Animations API observations for selected elements: at most 32 animations, 32 keyframes per animation, 24 safe CSS properties per keyframe, and 262,144 serialized bytes total. The validator rejects unknown fields, custom or unsafe CSS property names, URL-bearing values, invalid timing data, and over-limit records. It records values visible at capture time; it does not contain JavaScript or promise that the original animation can be replayed.
