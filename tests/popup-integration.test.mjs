import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../browser-extension/popup.js", import.meta.url), "utf8");

function harness() {
  const elements = new Map();
  const events = new Map();
  const make = (id) => {
    const value = { id, value: "", checked: false, disabled: false, hidden: false, textContent: "", children: [],
      addEventListener(type, handler) { events.set(`${id}:${type}`, handler); },
      click() { return events.get(`${id}:click`)?.({ target: value }); },
      replaceChildren(...items) { value.children = items; },
      append(...items) { value.children.push(...items); },
      appendChild(item) { value.children.push(item); return item; },
      removeAttribute() {},
      setAttribute() {},
      remove() {},
    };
    elements.set(id, value);
    return value;
  };
  ["start", "import", "import-file", "name", "tags", "target-selector", "include-screenshot", "include-composite", "record-animation", "status", "close-details", "details", "details-list", "details-preview", "details-shot", "canvas-frame", "canvas-image", "export-canvas", "composite-frame", "composite-image", "export-composite", "recording-frame", "recording-video", "export-recording", "recent"].forEach(make);
  elements.get("name").value = "Integration";
  elements.get("tags").value = "card, demo";
  elements.get("target-selector").value = "canvas#demo";
  elements.get("include-screenshot").checked = true;
  elements.get("include-composite").checked = true;
  elements.get("record-animation").checked = true;

  const calls = [];
  const chrome = {
    tabs: {
      query: async () => [{ id: 19 }],
      sendMessage: async (_id, message) => { calls.push(["picker", message]); return { ok: true }; },
    },
    scripting: { executeScript: async args => calls.push(["inject", args]) },
    runtime: { sendMessage: (message, callback) => callback({ captures: [] }) },
    downloads: { download: async () => 1 },
  };
  const document = {
    getElementById: id => elements.get(id),
    createElement: tag => ({ tagName: tag, children: [], append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); return item; }, addEventListener() {}, textContent: "", className: "", style: {} }),
  };
  vm.runInNewContext(source, { chrome, document, URL, Blob, TextEncoder, Date, JSON, Promise, console, setTimeout, clearTimeout, atob, btoa, window: { close() {} } });
  return { elements, events, calls };
}

test("popup forwards all local media options into the picker start message", async () => {
  const app = harness();
  await app.elements.get("start").click();
  const inject = app.calls.find(([type]) => type === "inject");
  const picker = app.calls.find(([type]) => type === "picker");
  assert.equal(Array.from(inject[1].files).join(","), "canvas-recorder.js,content.js");
  assert.deepEqual(JSON.parse(JSON.stringify(picker[1])), {
    type: "START_PICKER",
    name: "Integration",
    tags: ["card", "demo"],
    targetSelector: "canvas#demo",
    includeScreenshot: true,
    includeComposite: true,
    recordAnimation: true,
  });
});
