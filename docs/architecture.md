# UIQuarry architecture decisions

Status: accepted for the public/private split, 2026-11-19.

## Repository and product boundary

The public `UIQuarry` repository contains only browser-local capture and offline package tooling under GPL-3.0. It does not upload page data, host an HTTP receiver, or contain the paid web product. The sibling private `UIQuarry-Private` repository contains the commercial web workspace, authenticated import, cloud storage, permissions, billing, and AI retrieval. A user must deliberately import or push a package before the private product sees it.

## Product model

UIQuarry stores three related but distinct kinds of artifacts:

1. **Capture** is evidence of how a real page looked and behaved at a point in time. It preserves provenance and a sanitized, bounded subset of the page. It is not a source project and is not promised to be editable or compilable.
2. **Component package** is reusable source code and assets owned by a contributor. A package is ordinary files in Git with a `quarry.json` manifest. It may include references to captures and designs.
3. **Design** is an editable, constrained node tree with stable IDs, tokens, layout properties, variants, and assets. It is the source for UIQuarry's visual editor and code generator.

Keeping these types separate lets a designer capture any site for reference without pretending its DOM, CSS, or minified scripts can be converted back into an editable design.

## Distribution and registry

Git supplies distributed history and collaboration: clone, offline edits, commit, branch, fork, merge, and push to any Git remote. UIQuarry does not invent a second revision protocol or host Git objects in its first release. A registry indexes package identity, descriptive metadata, versions (Git commit IDs), file hashes, and access policy; package source remains in the Git remote. A later cloud service may mirror repositories, but it must preserve Git commit identity.

The public local-first path is extension → browser storage → offline package export. Cloud discovery and hosted sharing are private product capabilities and never run as an automatic callback from the public extension.

## Visual editing and code mapping

The durable design source is a versioned JSON Design IR rather than rendered canvas DOM. The editor renders and manipulates that model; the first code exporter maps the model one way to HTML/CSS and selected framework targets. Generated nodes receive stable `data-quarry-id` bindings. Later, UIQuarry may parse changes to its own generated code and update bound IR nodes. Unknown or unbound source stays code-only/read-only. Arbitrary third-party code and captured pages are not reverse-engineered into editable designs.

This is an explicit limit: exact bidirectional mapping between unconstrained JavaScript/TypeScript and a visual design model is not reliable. One-way export plus bounded round-tripping of UIQuarry-owned nodes is practical and can be tested.

## Capture and privacy boundaries

Capture only the selected node, bounded relevant ancestors/descendants, visible computed styles, viewport and bounds, source URL, and user-triggered interaction states. Sanitize scripts, form values, event handlers, hidden content, and dangerous URLs from the HTML snapshot. Do not collect whole-page script sources by default. Optional Web Animations API metadata records bounded timing and keyframe observations only; it does not recover JavaScript, shader source, event logic, or guarantee replay. When script recording is added, it must be an explicit user action scoped to a selected source, carry provenance/hash/license, and be visible in the export review.

Before publishing a package, show source and license/provenance metadata and let the contributor inspect captured assets for personal or secret data. A public URL alone does not grant redistribution rights.

## Increment plan

1. **Public local capture loop** — Chromium extension selection, sanitized Capture v1, browser-local storage, and offline Git package export.
2. **Private product import** — explicit package import, manifest review, identity/version index, Git remote links, namespaces, permissions, and billing.
3. **Private design editor** — constrained Design IR canvas, reusable components/tokens/variants, preview, and one-way HTML/CSS/React export.
4. **Private bounded code sync** — update only nodes carrying known UIQuarry IDs; surface conflicts rather than silently overwriting design or code.

The smallest meaningful end-to-end release is step 1. Do not block it on cloud deployment or the design editor.
