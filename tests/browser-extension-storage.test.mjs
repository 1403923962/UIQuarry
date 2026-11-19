import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const workerSource = await readFile(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");

const activeTab = { id: 31, active: true, windowId: 7 };
const fullJpeg = "data:image/jpeg;base64,/9j/2Q==";
const croppedJpeg = "data:image/jpeg;base64,/9j/4AAA/9k=";

function createHarness({ captureVisibleTab = async () => fullJpeg, query = async () => [activeTab], media = {} } = {}) {
  const listeners = [];
  let data = { captures: [] };
  const chrome = {
    runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
    storage: { local: {
      async get(defaults) { return structuredClone(data.captures ? data : defaults); },
      async set(next) { data = structuredClone(next); }
    } },
    tabs: { captureVisibleTab, query }
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID }, TextEncoder, atob, btoa, Blob,
    console: { ...console, warn() {} }, Date, JSON, Array, Number, String, Object, Promise, ...media });
  vm.runInContext(workerSource, context);
  async function send(message, sender = {}) {
    return new Promise((resolve, reject) => {
      let asyncResponse = false;
      const done = (response) => resolve(response);
      for (const listener of listeners) {
        if (listener(message, sender, done) === true) asyncResponse = true;
      }
      if (!asyncResponse) reject(new Error(`No handler for ${message.type}`));
    });
  }
  return { send, get captures() { return structuredClone(data.captures); } };
}

function capture(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "本地卡片",
    tags: ["卡片"],
    sourceUrl: "https://example.com/card",
    capturedAt: "2026-11-19T12:00:00.000Z",
    selector: "main > article",
    html: "<article>内容</article>",
    css: "article{display:block}",
    scripts: [],
    events: [],
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    bounds: { x: 20, y: 40, width: 400, height: 120 },
    ...overrides
  };
}

test("capture saves locally and delete removes only the requested record", async () => {
  const app = createHarness();
  assert.equal((await app.send({ type: "COMPONENT_CAPTURED", capture: capture() })).ok, true);
  assert.equal(app.captures.length, 1);
  const saved = app.captures[0];
  assert.equal(saved.name, "本地卡片");
  assert.ok(saved.localId);
  assert.ok(saved.savedAt);
  const deleted = await app.send({ type: "DELETE_CAPTURE", localId: saved.localId });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.deleted, true);
  assert.equal(app.captures.length, 0);
});

test("serialized local writes prevent concurrent captures from overwriting each other", async () => {
  const app = createHarness();
  const results = await Promise.all([
    app.send({ type: "COMPONENT_CAPTURED", capture: capture({ name: "一" }) }),
    app.send({ type: "COMPONENT_CAPTURED", capture: capture({ name: "二" }) }),
    app.send({ type: "COMPONENT_CAPTURED", capture: capture({ name: "三" }) })
  ]);
  assert.ok(results.every(result => result.ok));
  assert.equal(app.captures.length, 3);
  assert.deepEqual(new Set(app.captures.map(item => item.name)), new Set(["一", "二", "三"]));
});

test("Capture JSON import validates v1 and strips old local/server identity", async () => {
  const app = createHarness();
  const input = capture({ id: "old-id", createdAt: "old-time", localId: "old-local", savedAt: "old-save", sync: "synced" });
  assert.equal((await app.send({ type: "IMPORT_CAPTURE", capture: input })).ok, true);
  const saved = app.captures[0];
  assert.equal(saved.id, undefined);
  assert.equal(saved.createdAt, undefined);
  assert.equal(saved.localId === "old-local", false);
  assert.equal(saved.sync, undefined);
  assert.ok(saved.localId);
});

test("opt-in viewport capture stores a JPEG screenshot locally", async () => {
  let screenshots = 0;
  const app = createHarness({ captureVisibleTab: async (windowId, options) => {
    screenshots++;
    assert.equal(windowId, 7);
    assert.equal(options.format, "jpeg");
    assert.equal(options.quality, 78);
    return fullJpeg;
  } });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeScreenshot: true }, { tab: activeTab, frameId: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.screenshotCaptured, true);
  assert.equal(screenshots, 1);
  assert.equal(app.captures[0].screenshot, fullJpeg);
});

test("viewport capture is omitted when not requested or unavailable", async () => {
  let screenshots = 0;
  const app = createHarness({ captureVisibleTab: async () => { screenshots++; return "data:image/jpeg;base64,dGVzdA=="; } });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeScreenshot: false }, { tab: activeTab, frameId: 0 });
  assert.equal(result.screenshotCaptured, false);
  assert.equal(app.captures[0].screenshot, undefined);
  assert.equal(screenshots, 0);

  const inactive = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeScreenshot: true }, { tab: { ...activeTab, active: false }, frameId: 0 });
  assert.equal(inactive.ok, true);
  assert.equal(inactive.screenshotUnavailable, true);
  assert.equal(app.captures.length, 2);
  assert.equal(app.captures[0].screenshot, undefined);
});

test("composite capture crops only selected element pixels using screenshot-to-viewport scale", async () => {
  let createArgs, drawArgs;
  class OffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext(kind) { assert.equal(kind, "2d"); return { drawImage: (...args) => { drawArgs = args; } }; }
    async convertToBlob(options) { assert.equal(options.type, "image/jpeg"); return new Blob(["crop"], { type: "image/jpeg" }); }
  }
  const app = createHarness({ media: {
    createImageBitmap: async blob => { assert.equal(blob.type, "image/jpeg"); return { width: 2560, height: 1440, close() {} }; },
    OffscreenCanvas
  } });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeComposite: true }, { tab: activeTab, frameId: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.compositeCaptured, true);
  assert.equal(result.screenshotCaptured, false);
  assert.equal(app.captures[0].screenshot, undefined);
  assert.deepEqual([app.captures[0].compositeBitmap.width, app.captures[0].compositeBitmap.height], [800, 240]);
  assert.deepEqual(drawArgs.slice(1, 5), [40, 80, 800, 240]);
  assert.deepEqual(drawArgs.slice(5), [0, 0, 800, 240]);
});

test("compositor crop refuses an active tab switch before taking pixels", async () => {
  let screenshotCount = 0;
  const app = createHarness({
    query: async () => [{ ...activeTab, id: 99 }],
    captureVisibleTab: async () => { screenshotCount++; return fullJpeg; }
  });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeComposite: true }, { tab: activeTab, frameId: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.compositeUnavailable, true);
  assert.equal(app.captures[0].compositeBitmap, undefined);
  assert.equal(screenshotCount, 0);
});

test("compositor media is never taken from a nested frame", async () => {
  let screenshotCount = 0;
  const app = createHarness({ captureVisibleTab: async () => { screenshotCount++; return fullJpeg; } });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeScreenshot: true }, { tab: activeTab, frameId: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.screenshotUnavailable, true);
  assert.equal(app.captures[0].screenshot, undefined);
  assert.equal(screenshotCount, 0);
});

test("invalid imported video, crop, and recording attachments are rejected", async () => {
  const app = createHarness();
  for (const invalid of [
    { compositeBitmap: { width: -1, height: 4, dataUrl: croppedJpeg } },
    { canvasRecording: { mimeType: "video/webm", durationMs: 6001, dataUrl: "data:video/webm;base64,dGVzdA==" } }
  ]) {
    assert.equal((await app.send({ type: "IMPORT_CAPTURE", capture: capture(invalid) })).ok, false);
  }
  assert.equal(app.captures.length, 0);
});

test("local import preserves opt-in compositor and silent canvas recording attachments", async () => {
  const app = createHarness();
  const attachments = {
    compositeBitmap: { width: 640, height: 360, dataUrl: croppedJpeg },
    canvasRecording: { mimeType: "video/webm", durationMs: 3000, dataUrl: "data:video/webm;base64,dGVzdA==" }
  };
  const result = await app.send({ type: "IMPORT_CAPTURE", capture: capture(attachments) });
  assert.equal(result.ok, true);
  assert.deepEqual(app.captures[0].compositeBitmap, attachments.compositeBitmap);
  assert.deepEqual(app.captures[0].canvasRecording, attachments.canvasRecording);
});

test("import preserves the isolated canvas frame with no screenshot and rejects external bitmap URLs", async () => {
  const app = createHarness();
  const bitmap = { width: 1, height: 1, dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
  const imported = await app.send({ type: "IMPORT_CAPTURE", capture: capture({ canvasBitmap: bitmap }) });
  assert.equal(imported.ok, true);
  assert.deepEqual(app.captures[0].canvasBitmap, bitmap);
  assert.equal(app.captures[0].screenshot, undefined);
  for (const invalid of [{ ...bitmap, width: 0 }, { ...bitmap, dataUrl: "https://example.com/background.png" }]) {
    const result = await app.send({ type: "IMPORT_CAPTURE", capture: capture({ canvasBitmap: invalid }) });
    assert.equal(result.ok, false);
  }
  assert.equal(app.captures.length, 1);
});

test("transparent WebGL frame is omitted and recommends the site retention setting", async () => {
  class OffscreenCanvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { clearRect() {}, drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(32 * 32 * 4) }; } }; }
  }
  const app = createHarness({ media: {
    OffscreenCanvas,
    createImageBitmap: async () => ({ width: 16, height: 16, close() {} })
  } });
  const blankFrame = { width: 16, height: 16, dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture({ canvasBitmap: blankFrame }) });
  assert.equal(result.ok, true);
  assert.equal(result.canvasBitmapUnavailable, true);
  assert.equal(app.captures[0].canvasBitmap, undefined);
  assert.match(app.captures[0].notes, /全透明.*透明画布.*WebGL drawing buffer/);
});

test("keeps DOM/CSS when a combined screenshot would exceed the local storage budget", async () => {
  const jpeg = `data:image/jpeg;base64,${"A".repeat(7_000_000)}`;
  const app = createHarness({ captureVisibleTab: async () => jpeg });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture({ html: "x".repeat(1_500_000) }), includeScreenshot: true }, { tab: activeTab, frameId: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.screenshotCaptured, false);
  assert.equal(result.screenshotUnavailable, true);
  assert.equal(app.captures[0].html.length, 1_500_000);
  assert.equal(app.captures[0].screenshot, undefined);
});

test("media quota drops optional pixels before DOM and reports each omitted attachment", async () => {
  const almostThreeMb = "A".repeat(2_999_976);
  const mediaCapture = capture({
    html: "x".repeat(2_000_000),
    css: "y".repeat(1_000_000),
    compositeBitmap: { width: 1, height: 1, dataUrl: `data:image/jpeg;base64,${almostThreeMb}` },
    canvasRecording: { mimeType: "video/webm", durationMs: 3000, dataUrl: `data:video/webm;base64,${almostThreeMb}` }
  });
  const app = createHarness();
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: mediaCapture, includeScreenshot: true, includeComposite: false }, { tab: activeTab, frameId: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.screenshotUnavailable, true);
  assert.equal(result.compositeUnavailable, true);
  assert.equal(result.recordingUnavailable, true);
  assert.equal(app.captures[0].html.length, 2_000_000);
  assert.equal(app.captures[0].css.length, 1_000_000);
  assert.equal(app.captures[0].screenshot, undefined);
  assert.equal(app.captures[0].compositeBitmap, undefined);
  assert.equal(app.captures[0].canvasRecording, undefined);
});

test("rejects invalid or oversized capture payloads without changing local storage", async () => {
  const app = createHarness();
  const invalid = await app.send({ type: "IMPORT_CAPTURE", capture: capture({ sourceUrl: "javascript:alert(1)" }) });
  assert.equal(invalid.ok, false);
  const oversized = await app.send({ type: "IMPORT_CAPTURE", capture: capture({ html: "x".repeat(2_000_001) }) });
  assert.equal(oversized.ok, false);
  const badScreenshot = await app.send({ type: "IMPORT_CAPTURE", capture: capture({ screenshot: "data:image/png;base64,A" }) });
  assert.equal(badScreenshot.ok, false);
  assert.equal(app.captures.length, 0);
});

test("public extension captures locally; broader host access is optional and click-gated", async () => {
  const manifest = JSON.parse(await readFile(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
  assert.ok(!manifest.host_permissions);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*", "http://*/*"]);
  assert.ok(!manifest.permissions.includes("tabs") && !manifest.permissions.includes("tabCapture") && !manifest.permissions.includes("debugger"));
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage", "downloads"]);
  assert.ok(!/fetch\s*\(\s*["']https?:|XMLHttpRequest|sendBeacon\s*\(/.test(workerSource));
  const cli = await readFile(new URL("../cli/src/main.rs", import.meta.url), "utf8");
  assert.ok(!/reqwest|ureq|hyper::Client|TcpStream/.test(cli));
});
