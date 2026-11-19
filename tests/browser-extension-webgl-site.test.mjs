import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../browser-extension/popup-webgl.js", import.meta.url), "utf8");
const next = () => new Promise(resolve => setImmediate(resolve));

async function openPopup({ url = "https://canvas.test:8080/art", approve = true, failRegister = false } = {}) {
  const ids = ["webgl-toggle", "webgl-status", "webgl-reload"];
  const ui = Object.fromEntries(ids.map(id => [id, {
    addEventListener(name, handler) { this[name] = handler; },
    setAttribute(key, value) { this[key] = value; }
  }]));
  const calls = [], rules = new Map(), permissions = new Set();
  const tab = { id: 42, url };
  const chrome = {
    tabs: { query: async () => [tab], reload: async id => { calls.push(["reload", id]); } },
    permissions: {
      contains: async ({ origins: [o] }) => permissions.has(o),
      request: async ({ origins: [o] }) => { calls.push(["ask", o]); if (approve) permissions.add(o); return approve; },
      remove: async ({ origins: [o] }) => { calls.push(["remove", o]); return permissions.delete(o); }
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids: [id] }) => rules.has(id) ? [rules.get(id)] : [],
      registerContentScripts: async ([r]) => {
        if (failRegister) throw new Error("registration failed");
        rules.set(r.id, r);
      },
      unregisterContentScripts: async ({ ids: [id] }) => { rules.delete(id); }
    }
  };
  vm.runInNewContext(source, {
    document: { getElementById: id => ui[id] }, crypto: webcrypto, TextEncoder, URL,
    chrome, window: { close() {} }
  });
  for (let i = 0; i < 1000 && ui["webgl-status"].textContent === undefined; i++) await next();
  assert.ok(ui["webgl-status"].textContent);
  return { toggle: ui["webgl-toggle"], reload: ui["webgl-reload"], status: ui["webgl-status"], tab, rules, permissions, calls };
}

test("WebGL retention is off by default, asks only for this host, and registers early in the main frame", async () => {
  const { toggle, reload, tab, calls, rules, permissions } = await openPopup();
  assert.equal(calls.length, 0);
  assert.equal(reload.hidden, true);
  await toggle.click();
  assert.deepEqual(calls, [["ask", "https://canvas.test/*"]]);
  assert.deepEqual([...permissions], ["https://canvas.test/*"]);
  const [r] = rules.values();
  assert.deepEqual([...r.matches], ["https://canvas.test/*"]);
  assert.deepEqual([...r.js], ["webgl-preserve.js"]);
  assert.equal(r.world, "MAIN");
  assert.equal(r.runAt, "document_start");
  assert.equal(r.allFrames, false);
  assert.equal(r.persistAcrossSessions, true);
  assert.equal(toggle["aria-pressed"], "true");
  tab.url = "https://another.test/"; await reload.click();
  assert.equal(calls.length, 1);
  tab.url = "https://canvas.test/"; await reload.click();
  assert.deepEqual(calls[1], ["reload", 42]);
  await toggle.click();
  assert.equal(rules.size, 0);
  assert.equal(permissions.size, 0);
  assert.equal(toggle["aria-pressed"], "false");
});

test("denial or failed registration leaves no enabled script or new host grant", async () => {
  for (const scenario of [{ approve: false }, { failRegister: true }]) {
    const popup = await openPopup(scenario);
    await popup.toggle.click();
    assert.equal(popup.rules.size, 0);
    assert.equal(popup.permissions.size, 0);
    assert.equal(popup.reload.hidden, true);
    assert.equal(popup.toggle["aria-pressed"], "false");
  }
});

test("browser internal pages cannot request a host grant", async () => {
  const popup = await openPopup({ url: "edge://extensions/" });
  assert.equal(popup.toggle.disabled, true);
  assert.equal(popup.calls.length, 0);
});
