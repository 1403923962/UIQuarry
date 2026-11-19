# UIQuarry browser extension

Chrome Manifest V3 prototype for choosing and archiving a page element. It stores captures only in `chrome.storage.local`; this public extension has no upload endpoint, cloud client, or automatic network request.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this `browser-extension` directory.
3. Open a normal web page, then click the UIQuarry toolbar icon.
4. Enter a component name and optional comma-separated tags, then click **Pick an element**.
5. Hover to inspect the top element. Use **↑/↓** to cycle through overlapping elements or **C** to select a canvas at that point, including pointer-transparent backgrounds. Click or press **Enter** to save the highlighted element. **Esc** cancels.

If you know the element's selector, enter it in **精确定位** before starting (for example, `canvas#bg-canvas`). A unique match stays selected as the pointer moves. Selecting a canvas saves the current frame as a PNG using its backing resolution. Open **详情 → 导出画布 PNG** to download it. Cross-origin canvas restrictions and encoding limits can leave pixel data unavailable. In that case the saved record includes the reason. Document lookup currently targets the main document.

The popup shows the five most recent local captures. Each item can be exported as a clean Capture v1 JSON file or deleted from this browser. Capture records are in the extension's local storage under `captures`; exported JSON intentionally omits local bookkeeping fields so it can be passed to the offline CLI.

## Capture and privacy behavior

- Captures a sanitized HTML subtree, a curated set of computed CSS properties for the root and descendants, a selector, viewport dimensions, bounding box, and timestamp, all on the current page and in local browser storage. The source URL omits credentials, query parameters, and fragments to reduce accidental leakage.
- The optional screenshot checkbox starts unchecked. Enable it to save a separate JPEG of the visible viewport alongside the selection. A selected canvas's own PNG is available independently of this checkbox.
- Script and event arrays remain empty. Arbitrary page JavaScript cannot be reliably attributed to an element; script recording must be an explicit later action.
- Removes script/style/iframe/object/embed/template nodes, hidden descendants (`hidden`, `aria-hidden`, `display:none`, and hidden visibility), inline event handlers, nonce/integrity attributes, and form control values. Review text and asset URLs before sharing because page content can still contain private information.
- Caps the captured subtree at 300 elements, HTML at 2 MB, computed CSS at 1 MB, and a JPEG viewport screenshot at 7 MiB. Recent local captures stay within an 8 MiB storage budget; if the screenshot would exceed it, the extension keeps the DOM/CSS capture and omits the screenshot.

## Manual checks

- Load the unpacked extension and capture a card/button from a page; confirm the selector and styles appear in local storage.
- Press `Esc` while the picker is active; the page should return to normal without a capture.
- Inspect the extension's service worker network panel while capturing; no upload request should be made.
- Export a stored capture manually through the offline CLI when you want to create a Git package.
- Click **Export** on a recent item, confirm a JSON file downloads, and pass that file to `quarry package create`.
- Click **Delete** and confirm the item disappears from the local list; no network request should occur.
- Click **导入 Capture JSON**, select a previously exported file, and confirm it appears in Recent captures; malformed or oversized files should be rejected locally.
- Capture a page with a canvas/fixed background, verify the saved item's details show the viewport image, export it, and confirm the JSON includes a `screenshot` data URL. Repeat with the checkbox disabled and confirm there is no screenshot field.

Pages such as `chrome://` and the Chrome Web Store prohibit content-script injection. The popup reports the browser's error on those pages.

The local storage message flow has automated regression checks in `tests/browser-extension-storage.test.mjs` (`node --test tests/browser-extension-storage.test.mjs`).
