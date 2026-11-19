import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { randomUUID, webcrypto } from "node:crypto";
import vm from "node:vm";

const workerSource = await readFile(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");

function createHarness({ captureVisibleTab = async () => "data:image/jpeg;base64,dGVzdA==" } = {}) {
  const listeners = [];
  let data = { captures: [] };
  const chrome = {
    runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
    storage: { local: {
      async get(defaults) { return structuredClone(data.captures ? data : defaults); },
      async set(next) { data = structuredClone(next); }
    } },
    tabs: { captureVisibleTab }
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID }, TextEncoder, console: { ...console, warn() {} }, Date, JSON, Array, Number, String, Object, Promise });
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
    return "data:image/jpeg;base64,dGVzdA==";
  } });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeScreenshot: true }, { tab: { active: true, windowId: 7 } });
  assert.equal(result.ok, true);
  assert.equal(result.screenshotCaptured, true);
  assert.equal(screenshots, 1);
  assert.equal(app.captures[0].screenshot, "data:image/jpeg;base64,dGVzdA==");
});

test("viewport capture is omitted when not requested or unavailable", async () => {
  let screenshots = 0;
  const app = createHarness({ captureVisibleTab: async () => { screenshots++; return "data:image/jpeg;base64,dGVzdA=="; } });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeScreenshot: false }, { tab: { active: true, windowId: 7 } });
  assert.equal(result.screenshotCaptured, false);
  assert.equal(app.captures[0].screenshot, undefined);
  assert.equal(screenshots, 0);

  const inactive = await app.send({ type: "COMPONENT_CAPTURED", capture: capture(), includeScreenshot: true }, { tab: { active: false, windowId: 7 } });
  assert.equal(inactive.ok, true);
  assert.equal(inactive.screenshotUnavailable, true);
  assert.equal(app.captures.length, 2);
  assert.equal(app.captures[0].screenshot, undefined);
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

test("keeps DOM/CSS when a combined screenshot would exceed the local storage budget", async () => {
  const jpeg = `data:image/jpeg;base64,${"A".repeat(7_000_000)}`;
  const app = createHarness({ captureVisibleTab: async () => jpeg });
  const result = await app.send({ type: "COMPONENT_CAPTURED", capture: capture({ html: "x".repeat(1_500_000) }), includeScreenshot: true }, { tab: { active: true, windowId: 7 } });
  assert.equal(result.ok, true);
  assert.equal(result.screenshotCaptured, false);
  assert.equal(result.screenshotUnavailable, true);
  assert.equal(app.captures[0].html.length, 1_500_000);
  assert.equal(app.captures[0].screenshot, undefined);
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

test("public extension and CLI contain no automatic upload surface", async () => {
  const manifest = JSON.parse(await readFile(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
  assert.ok(!manifest.host_permissions);
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage", "downloads"]);
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon\s*\(/.test(workerSource));
  const cli = await readFile(new URL("../cli/src/main.rs", import.meta.url), "utf8");
  assert.ok(!/reqwest|ureq|hyper::Client|TcpStream/.test(cli));
});
