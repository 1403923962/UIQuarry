import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../browser-extension/popup.js", import.meta.url), "utf8");

function harness({ captures = [] } = {}) {
  const elements = new Map();
  const events = new Map();
  const createdEvents = new WeakMap();
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
  ["start", "import", "import-file", "name", "tags", "target-selector", "include-animations", "include-screenshot", "include-composite", "record-animation", "status", "close-details", "details", "details-list", "details-preview", "details-shot", "canvas-frame", "canvas-image", "export-canvas", "composite-frame", "composite-image", "export-composite", "recording-frame", "recording-video", "export-recording", "animations-frame", "animations-preview", "animations-summary", "recent"].forEach(make);
  elements.get("name").value = "Integration";
  elements.get("tags").value = "card, demo";
  elements.get("target-selector").value = "canvas#demo";
  elements.get("include-screenshot").checked = true;
  elements.get("include-composite").checked = true;
  elements.get("record-animation").checked = true;
  elements.get("include-animations").checked = true;

  const calls = [];
  const chrome = {
    tabs: {
      query: async () => [{ id: 19 }],
      sendMessage: async (_id, message) => { calls.push(["picker", message]); return { ok: true }; },
    },
    scripting: { executeScript: async args => calls.push(["inject", args]) },
    runtime: { sendMessage: (message, callback) => callback({ captures }) },
    downloads: { download: async () => 1 },
  };
  const document = {
    getElementById: id => elements.get(id),
    createElement: tag => {
      const value = { tagName: tag, children: [], append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); return item; },
        addEventListener(type, handler) { const handlers = createdEvents.get(value) || {}; handlers[type] = handler; createdEvents.set(value, handlers); },
        click() { return createdEvents.get(value)?.click?.({ target: value }); }, textContent: "", className: "", style: {} };
      return value;
    },
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
    includeAnimations: true,
    includeScreenshot: true,
    includeComposite: true,
    recordAnimation: true,
  });
});

test("popup details show captured DOM animation observation metadata", () => {
  const capture = {
    name: "Card",
    sourceUrl: "https://example.test/",
    selector: "#card",
    capturedAt: "2026-11-19T12:00:00.000Z",
    bounds: { width: 300, height: 200 },
    html: "<div id=card></div>",
    animations: [{ targetId: "q0", kind: "CSSTransition", playState: "running", currentTime: 120,
      playbackRate: 1, timelineType: "document", timing: { duration: 300, delay: 0, endDelay: 0, iterations: 1,
        direction: "normal", easing: "ease", fill: "both" }, keyframes: [{ offset: 0, properties: { opacity: 0 } }] }]
  };
  const app = harness({ captures: [capture] });
  const row = app.elements.get("recent").children[0];
  const actions = row.children[1];
  actions.children[0].click();
  assert.equal(app.elements.get("animations-frame").hidden, false);
  assert.match(app.elements.get("animations-summary").textContent, /1 条.*不含动画实现代码/);
  assert.match(app.elements.get("animations-preview").textContent, /CSSTransition/);
  assert.match(app.elements.get("animations-preview").textContent, /"opacity": 0/);
});
