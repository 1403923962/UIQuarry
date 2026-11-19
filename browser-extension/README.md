# UIQuarry browser extension

Chrome Manifest V3 prototype for choosing and archiving a page element. It stores captures only in `chrome.storage.local`; this public extension has no upload endpoint, cloud client, or automatic network request.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this `browser-extension` directory.
3. Open a normal web page, then click the UIQuarry toolbar icon.
4. Enter a component name and optional comma-separated tags, then click **Pick an element**.
5. Scroll the page to find the target and left-click to pin that position. Scroll down or press **↓** to select the next layer underneath. Scroll up or press **↑** to go back. **C** selects a canvas at the pinned point, including pointer-transparent backgrounds. Click again or press **Enter** to save. **Esc** releases the pin and restores page scrolling. Press **Esc** again to exit.

This release requires Chrome/Edge 113 or later for the local storage budget used by media attachments.

If you know the element's selector, enter it in **精确定位** before starting (for example, `canvas#bg-canvas`). A unique match stays selected as the pointer moves. Selecting a canvas saves the current frame as a PNG using its backing resolution. Open **详情 → 导出画布 PNG** to download it. Cross-origin canvas restrictions and encoding limits can leave pixel data unavailable. In that case the saved record includes the reason. Document lookup currently targets the main document.

The popup shows the five most recent local captures. Each item can be exported as a clean Capture v1 JSON file or deleted from this browser. Capture records are in the extension's local storage under `captures`; exported JSON intentionally omits local bookkeeping fields so it can be passed to the offline CLI.

## Capture and privacy behavior

WebGL retention is off by default. Enable it for a specific site from the popup; after granting the optional host permission, refresh before creating a WebGL context. It only affects new WebGL contexts in the page's main world; worker contexts, WebGPU, existing contexts, shaders, and source code are unchanged. Disable it in the same popup.

- Captures a sanitized HTML subtree, a curated set of computed CSS properties for the root and descendants, a selector, viewport dimensions, bounding box, and timestamp, all on the current page and in local browser storage. The source URL omits credentials, query parameters, and fragments to reduce accidental leakage.
- The optional screenshot checkbox starts unchecked. Enable it to save a separate JPEG of the visible viewport alongside the selection. A selected canvas's own PNG is available independently of this checkbox.
- **CSS/WAAPI 动画关键帧** can be sampled with the popup checkbox. The snapshot includes bounded timing, play state, and safe keyframe values linked to captured node IDs. It is read-only metadata, not the JavaScript that created or triggered the animation. Script and event arrays remain empty by default.
- **WebGL 保帧** is off by default. Enable it for a specific site when you want newly created WebGL contexts on that host to use `preserveDrawingBuffer: true`; then refresh the page. It does not alter existing contexts, WebGPU, worker-created OffscreenCanvas contexts, source code, or shader code. It requests the host permission only after your click and can be disabled from the same popup.
- **CSS/WAAPI animation metadata** is opt-in. It snapshots active effects on the selected DOM subtree, maps them to captured node IDs, and keeps bounded keyframe/timing values. It does not read JavaScript source, invoke page handlers, or control play/pause/time.
- **录制画布动效** stores about three seconds (maximum six) of silent WebM from the selected canvas. Keep the page visible; move the pointer during capture if the animation responds to it. If a WebGL video is blank, enable this site's WebGL retention and refresh before recording. **裁切目标区域合成图** stores one JPEG crop of the browser-composited selected bounds, which can preserve a WebGL frame after its drawing buffer is cleared. Neither result is executable source code.
- Script and event arrays remain empty. Arbitrary page JavaScript cannot be reliably attributed to an element; script recording must be an explicit later action.
- Removes script/style/iframe/object/embed/template nodes, hidden descendants (`hidden`, `aria-hidden`, `display:none`, and hidden visibility), inline event handlers, nonce/integrity attributes, and form control values. Review text and asset URLs before sharing because page content can still contain private information.
- Caps the captured subtree at 300 elements, HTML at 2 MB, computed CSS at 1 MB, and a JPEG viewport screenshot at 7 MiB. Recent local captures stay within an 8 MiB storage budget; if the screenshot would exceed it, the extension keeps the DOM/CSS capture and omits the screenshot.

## Manual checks

- Load the unpacked extension and capture a card/button from a page; confirm the selector and styles appear in local storage.
- Pin a point, move the pointer and roll the wheel. Only the layers at the pinned point should cycle. Press `Esc` to pick another point, then `Esc` to exit.
- Inspect the extension's service worker network panel while capturing; no upload request should be made.
- Export a stored capture manually through the offline CLI when you want to create a Git package.
- Click **Export** on a recent item, confirm a JSON file downloads, and pass that file to `quarry package create`.
- Click **Delete** and confirm the item disappears from the local list; no network request should occur.
- Click **导入 Capture JSON**, select a previously exported file, and confirm it appears in Recent captures; malformed or oversized files should be rejected locally.
- Capture a CSS animation with **CSS/WAAPI animation metadata** enabled; Details should show keyframes/timing linked to a captured node ID, while scripts/events stay separate.
- Capture a page with a canvas/fixed background, verify the saved item's details show the viewport image, export it, and confirm the JSON includes a `screenshot` data URL. Repeat with the checkbox disabled and confirm there is no screenshot field.

Pages such as `chrome://` and the Chrome Web Store prohibit content-script injection. The popup reports the browser's error on those pages.

For media review, select a small visible element and enable only the target crop to save the browser-composited pixels within its visible bounds. On a moving Canvas, enable recording, wait a few seconds, then play the local WebM from Details. It is silent and is video, not source code.

The extension, local media handling, WebGL hook, and recorder have automated regression checks in `tests/*.mjs`. Run `node --test --test-concurrency=1 tests/*.mjs` from the repository root so the isolated Edge instances do not compete for GPU contexts.
