import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = await readFile(new URL("../browser-extension/package-zip.js", import.meta.url), "utf8");

function load() {
  const context = {
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    ArrayBuffer,
    DataView,
    Blob,
    Date,
    Set,
    String,
    JSON,
    Error,
    Promise,
    URL,
    crypto: webcrypto,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.UIQuarryPackageExport;
}

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const size = view.getUint32(offset + 22, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  return entries;
}

const png = "data:image/png;base64,iVBORw0KGgo=";
const jpg = "data:image/jpeg;base64,/9j/4AAQ";

test("package export builds a CLI-compatible local ZIP with media payloads", async () => {
  const api = load();
  const result = await api.buildPackage({
    localId: "123e4567-e89b-12d3-a456-426614174000",
    name: "漂亮 Card / Demo",
    sourceUrl: "https://example.test/page",
    capturedAt: "2026-11-20T09:00:00.000Z",
    tags: ["card", "card"],
    schemaVersion: 1,
    selector: ".card",
    html: "<article class=card></article>",
    css: ".card{color:red}",
    scripts: [],
    events: [],
    viewport: { width: 800, height: 600 },
    bounds: { x: 0, y: 0, width: 320, height: 180 },
    canvasBitmap: { width: 1, height: 1, dataUrl: png },
    screenshot: jpg
  });
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.manifest.kind, "capture");
  assert.equal(result.manifest.license, "NOASSERTION");
  assert.match(result.manifest.id, /^[a-z0-9][a-z0-9._-]*$/);
  assert.equal(result.manifest.entrypoints[0], `captures/${result.manifest.id}/capture.json`);
  assert.equal(result.manifest.files.length, 3);
  assert.equal(result.capture.id, result.manifest.id);
  assert.ok(!Number.isNaN(Date.parse(result.capture.createdAt)));
  assert.equal(result.capture.localId, undefined);

  const entries = readZip(result.bytes);
  assert.deepEqual([...entries.keys()], [
    "quarry.json",
    `captures/${result.manifest.id}/capture.json`,
    "media/canvas.png",
    "media/viewport.jpg"
  ]);
  const manifest = JSON.parse(new TextDecoder().decode(entries.get("quarry.json")));
  assert.equal(manifest.files[0].path, `captures/${result.manifest.id}/capture.json`);
  for (const file of manifest.files) {
    const body = entries.get(file.path);
    assert.ok(body, file.path);
    assert.equal(file.size, body.byteLength);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(JSON.parse(new TextDecoder().decode(entries.get(manifest.entrypoints[0]))).id, result.manifest.id);
});

test("package identifiers stay within the manifest path grammar", () => {
  const api = load();
  assert.equal(api.safeIdentifier("中文组件 / ../危险"), "capture");
  assert.equal(api.safeIdentifier("Hero Card_v2"), "hero-card_v2");
});

test("review metadata can set the manifest license without adding non-schema fields", async () => {
  const api = load();
  const result = await api.buildPackage({
    name: "Reviewed",
    sourceUrl: "https://example.test/source",
    capturedAt: "2026-11-20T09:00:00.000Z",
    schemaVersion: 1,
    selector: ".reviewed",
    html: "<div></div>",
    css: "",
    scripts: [],
    events: [],
    viewport: { width: 1, height: 1 },
    bounds: { x: 0, y: 0, width: 1, height: 1 }
  }, { metadata: { license: "MIT", sourceUrl: "https://example.test/source" } });
  assert.equal(result.manifest.license, "MIT");
  assert.equal(result.manifest.sourceUrl, "https://example.test/source");
  assert.deepEqual(Object.keys(result.manifest).sort(), ["createdAt", "entrypoints", "files", "id", "kind", "license", "name", "schemaVersion", "sourceUrl"]);
});
