import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const browser = process.env.UIQUARRY_TEST_BROWSER ?? [
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/chromium", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(path => path && existsSync(path));

class DevToolsClient {
  #socket;
  #nextId = 0;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    const id = ++this.#nextId;
    const response = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  }

  close() { this.#socket.close(); }
}

async function waitForDevTools(profile, child, stderr, targetUrl) {
  const deadline = Date.now() + 15000;
  let port;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited early: ${stderr()}`);
    try {
      [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/);
      if (port) break;
    } catch { /* Browser is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!port) throw new Error(`Browser did not start DevTools: ${stderr()}`);

  const endpoint = `http://127.0.0.1:${port}/json/list`;
  let page;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited early: ${stderr()}`);
    try {
      page = (await (await fetch(endpoint)).json()).find(target => target.type === "page" && target.url.startsWith(targetUrl));
      if (page?.webSocketDebuggerUrl) break;
    } catch { /* DevTools is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!page?.webSocketDebuggerUrl) throw new Error(`Browser did not expose a page: ${stderr()}`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to browser DevTools")), { once: true });
  });
  return new DevToolsClient(socket);
}

async function stopBrowser(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  await new Promise(resolve => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  });
}

test("Chromium records and decodes changing WebGL frames, then releases the stream", {
  skip: !browser && "Set UIQUARRY_TEST_BROWSER to run the browser WebGL recording check",
}, async t => {
  const html = await readFile(new URL("./fixtures/webgl-recording.html", import.meta.url));
  const recorder = await readFile(new URL("../browser-extension/canvas-recorder.js", import.meta.url));
  const preserveHook = await readFile(new URL("../browser-extension/webgl-preserve.js", import.meta.url));
  const server = createServer((req, res) => {
    if (req.url === "/" || req.url.startsWith("/?")) {
      const preserved = new URL(req.url, "http://localhost").searchParams.has("preserve");
      const page = html.toString().replace("<!-- WEBGL_PRESERVE_HOOK -->",
        preserved ? '<script src="/webgl-preserve.js"></script>' : "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
    }
    else if (req.url === "/canvas-recorder.js") res.writeHead(200, { "Content-Type": "text/javascript" }).end(recorder);
    else if (req.url === "/webgl-preserve.js") res.writeHead(200, { "Content-Type": "text/javascript" }).end(preserveHook);
    else res.writeHead(404).end();
  });
  const profile = await mkdtemp(join(tmpdir(), "uiquarry-webm-test-"));
  let child;
  let devtools;
  let browserStderr = "";
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const targetUrl = `http://127.0.0.1:${server.address().port}/`;
    child = spawn(browser, [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      "--disable-background-networking", "--enable-unsafe-swiftshader", "--window-size=800,600",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      targetUrl,
    ], { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { browserStderr = (browserStderr + chunk).slice(-8000); });
    devtools = await waitForDevTools(profile, child, () => browserStderr, targetUrl);
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");
    await devtools.send("Page.navigate", { url: targetUrl });
    for (const preserve of [false, true]) {
      const url = targetUrl + (preserve ? "?preserve=1" : "");
      await devtools.send("Page.navigate", { url });
      const deadline = Date.now() + 25000;
      let result = "PENDING";
      while ((result === "PENDING" || result === "MISSING") && Date.now() < deadline) {
        result = await devtools.evaluate("document.readyState !== 'complete' ? 'PENDING' : (document.querySelector('#result')?.textContent ?? 'MISSING')");
        if (result === "PENDING" || result === "MISSING") await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (result?.startsWith("SKIP:")) { t.skip(result.slice(5)); return; }
      assert.notEqual(result, "PENDING", `Chromium did not finish the fixture. stderr: ${browserStderr}`);
      assert.notEqual(result, "MISSING", `Fixture result element is missing at ${await devtools.evaluate("location.href")}: ${await devtools.evaluate("document.body?.innerText ?? document.documentElement.outerHTML.slice(0, 500)")}`);
      const report = JSON.parse(result);
      assert.equal(report.ok, true, report.error || "WebGL recording fixture failed");
      assert.equal(report.preserveDrawingBuffer, preserve, "Fixture created a context with unexpected preservation");
      assert.ok(report.recordedDurationSeconds >= 2.5 && report.recordedDurationSeconds <= 4,
        `Unexpected recorder duration: ${report.recordedDurationSeconds}s`);
      assert.ok(report.decodedDurationSeconds >= 2.5 && report.decodedDurationSeconds <= 4,
        `Unexpected decoded duration: ${JSON.stringify(report)}`);
      assert.ok(report.decodedFrames >= 3, `Only ${report.decodedFrames} frames decoded`);
      assert.ok(report.uniquePixels >= 2, `Decoded frames did not show animation: ${report.samples}`);
      assert.equal(report.audioTracks, 0, "The capture stream unexpectedly included audio");
      assert.deepEqual(report.trackStatesAfterRecord, ["ended"], "Recorder did not stop its owned video track");
    }
  } finally {
    devtools?.close();
    if (child) await stopBrowser(child);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
