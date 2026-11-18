# UIQuarry browser extension

Chrome Manifest V3 prototype for choosing and archiving a page element. It stores captures only in `chrome.storage.local`; this public extension has no upload endpoint, cloud client, or automatic network request.

## Load in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this `browser-extension` directory.
3. Open a normal web page, then click the UIQuarry toolbar icon.
4. Enter a component name and optional comma-separated tags, then click **Pick an element**.
5. Hover to preview an element, click it to capture, or press **Esc** to cancel.

The popup shows the five most recent local captures. Capture JSON is in the extension's local storage under `captures`.

## Capture and privacy behavior

- Captures a sanitized HTML subtree, a curated set of computed CSS properties for the root and descendants, a selector, viewport dimensions, bounding box, URL, and timestamp, all on the current page and in local browser storage.
- Script and event arrays remain empty. Arbitrary page JavaScript cannot be reliably attributed to an element; script recording must be an explicit later action.
- Removes script/style/iframe/object/embed/template nodes, inline event handlers, nonce/integrity attributes, and form control values. Review text and asset URLs before sharing because page content can still contain private information.
- Caps the captured subtree at 300 elements, HTML at 2 MB, and computed CSS at 1 MB. Recent local captures are pruned to stay within an 8 MB storage budget.

## Manual checks

- Load the unpacked extension and capture a card/button from a page; confirm the selector and styles appear in local storage.
- Press `Esc` while the picker is active; the page should return to normal without a capture.
- Inspect the extension's service worker network panel while capturing; no upload request should be made.
- Export a stored capture manually through the offline CLI when you want to create a Git package.

Pages such as `chrome://` and the Chrome Web Store prohibit content-script injection. The popup reports the browser's error on those pages.
