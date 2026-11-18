import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { randomUUID, webcrypto } from "node:crypto";
import vm from "node:vm";

const workerSource = await readFile(new URL("../browser-extension/service-worker.js", import.meta.url), "utf8");

function createHarness() {
  const listeners = [];
  let data = { captures: [] };
  const chrome = {
    runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
    storage: { local: {
      async get(defaults) { return structuredClone(data.captures ? data : defaults); },
      async set(next) { data = structuredClone(next); }
    } }
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID }, TextEncoder, console, Date, JSON, Array, Number, String, Object, Promise });
  vm.runInContext(workerSource, context);
  async function send(message) {
    return new Promise((resolve, reject) => {
      let asyncResponse = false;
      const done = (response) => resolve(response);
      for (const listener of listeners) {
        if (listener(message, {}, done) === true) asyncResponse = true;
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

test("rejects invalid or oversized capture payloads without changing local storage", async () => {
  const app = createHarness();
  const invalid = await app.send({ type: "IMPORT_CAPTURE", capture: capture({ sourceUrl: "javascript:alert(1)" }) });
  assert.equal(invalid.ok, false);
  const oversized = await app.send({ type: "IMPORT_CAPTURE", capture: capture({ html: "x".repeat(2_000_001) }) });
  assert.equal(oversized.ok, false);
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
