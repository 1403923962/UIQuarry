# UIQuarry v1 format and architecture

UIQuarry stores three deliberately different kinds of artifacts. The public repository defines the interchange format and local tooling; the paid web product lives in the private repository.

- **Capture** is an immutable observation of a live page element. It preserves sanitized markup, scoped styles, geometry, optional interaction samples, and an optional screenshot of the current visible viewport. The screenshot preserves canvas/video/background pixels that sit outside the selected DOM subtree. It is useful as a reference, but is not claimed to be an editable or reversible design source.
- **Design** is a constrained, renderer-independent tree edited on a canvas. The first generator maps this tree to HTML/CSS (and later React); this is the supported design-to-code direction. Importing code back into a design is supported only for UIQuarry-generated output carrying stable `data-quarry-id` bindings, and only to the extent the importer recognizes it. Arbitrary JSX, CSS, or captured DOM remain references/previews.
- **Component** is a reusable code package with source files and optional previews/design bindings.

The JSON Schemas in `schemas/` define the v1 interchange contract. Examples in `examples/` are intended to validate against them. The Capture schema is used for a local capture and an optional, user-initiated import: `id` and `createdAt` may be added by a private registry after import. `schemaVersion` is an integer; breaking changes require a new major version and a migration path. Additive optional fields may be introduced compatibly.

## Git is the distributed repository

A UIQuarry package is an ordinary directory committed to an ordinary Git repository. Clone, commit, branch, merge, fork, and push use standard Git tools and remotes (for example GitHub or a self-hosted Git provider). UIQuarry does not define a custom Git protocol or replace Git history. A package's files are listed with SHA-256 hashes in `quarry.json`; the Git commit is the immutable revision that groups those file versions. The private product may index `(package id, remote, commit)` after an explicit import, while clients remain able to work offline and sync with standard Git.

The manifest's `origin` is provenance for the publication/source revision, not a substitute for a Git remote or a claim that a source capture is safe to redistribute. A license and source URL should be recorded where applicable. Always review captured content for personal data, credentials, copyrighted assets, and redistribution rights before publishing.

## Capture rules

Capture only the selected element and its necessary descendants. Sanitize the HTML before persistence: remove scripts, inline event handlers, form values, and active embedded content; do not collect cookies, storage, network credentials, or the full page's scripts. `scripts` is empty by default. A future explicit script import must identify its source, relation, and license and require a separate user action. Computed CSS should be scoped to the captured fragment and include only selected/contextual declarations; keep the original page URL and selector as provenance. Geometry is relative to the recorded viewport. An optional screenshot is a PNG/JPEG data URL of the current visible tab viewport (maximum 10,000,000 characters); it is opt-in context for canvas and other pixels that DOM/CSS cannot reconstruct, not a stitched full-page capture. Interaction samples are observations, not executable replay code.

When the selected element is a `<canvas>`, the optional `canvasBitmap` object stores its own pixels at the moment of capture. `width` and `height` are positive integers taken from the canvas backing buffer. The element's size on screen is recorded separately in `bounds`. `dataUrl` contains a base64 PNG with a maximum of 5,000,000 characters including the `data:image/png;base64,` prefix. WebGL may clear its drawing buffer after compositing, and cross-origin drawing can taint a canvas; in those cases omit `canvasBitmap` and record the reason in `notes`.

An optional `compositeBitmap` stores a JPEG crop of the selected element's final visible pixels as rendered by the browser compositor. It can preserve a WebGL frame after its drawing buffer has been cleared. Its dimensions are the crop's pixel dimensions (which may differ from CSS-pixel `bounds` because of device scale); its data URL is limited to 3,000,000 characters. This crop can include overlays, clipped/occluded regions, and only captures one instant.

An optional `canvasRecording` stores at most 6,000 ms of video from the selected canvas via `captureStream`, when that API and codec are available. It is capped at 3,000,000 data-URL characters and must use `video/webm`. It may include only canvas video frames: it is not a copy of the component's code or shader and may not reproduce cursor interaction. `canvasBitmap`, `compositeBitmap`, `canvasRecording`, and the broader viewport `screenshot` are independent optional observations; they are not executable replay data.

An optional `animations` array records bounded Web Animations API observations for the selected subtree: target IDs, play state, timeline type, timing, and sampled keyframe values. It holds at most 32 animations, 32 keyframes per animation, and 24 safe CSS properties per keyframe. CSS custom properties, `content`, active URL values, and unsupported fields are excluded; the offline CLI also caps the serialized `animations` value at 262,144 bytes. This metadata does not include JavaScript, event handlers, shader source, or the logic that created an animation, and it does not guarantee replay of the original behavior. Older captures may omit `animations`.

## Package layout

Suggested paths are conventions; manifest `files` is authoritative.

```text
quarry.json
captures/<id>/capture.json
designs/<id>/design.json
components/<id>/src/...
previews/<id>.png
```

Keep secrets and local databases out of a package. Keep capture, design, and implementation assets separate even when they refer to each other.

## Design export boundary

The Design IR is intentionally smaller than the web platform: semantic nodes, a limited layout model, plain style values, reusable tokens, variants, and assets. Canvas edits change the IR; an exporter renders it to target code. Generated component roots and recognized subnodes carry stable `data-quarry-id` values so a later importer can map edits back to known nodes. A normal code edit that cannot be mapped safely should be surfaced for review rather than silently discarded. This provides reliable WYSIWYG for authored content without promising lossless round-trips for arbitrary web code.
