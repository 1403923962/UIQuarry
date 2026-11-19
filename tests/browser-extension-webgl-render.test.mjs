import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const browser = process.env.UIQUARRY_TEST_BROWSER ?? [
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe"),
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/chromium", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(path => path && existsSync(path));

test("Chromium reads the drawn WebGL color from PNG in a later task with preservation enabled", {
  skip: !browser && "Set UIQUARRY_TEST_BROWSER to run the browser WebGL check",
}, async t => {
  const html = await readFile(new URL("./fixtures/webgl-frame.html", import.meta.url));
  const hook = await readFile(new URL("../browser-extension/webgl-preserve.js", import.meta.url));
  const server = createServer((req, res) => {
    if (req.url === "/") res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    else if (req.url === "/webgl-preserve.js") res.writeHead(200, { "Content-Type": "text/javascript" }).end(hook);
    else res.writeHead(404).end();
  });
  const profile = await mkdtemp(join(tmpdir(), "uiquarry-webgl-test-"));
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const { stdout } = await promisify(execFile)(browser, [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      "--disable-background-networking", "--virtual-time-budget=3000", "--dump-dom",
      "--user-data-dir=" + profile, "http://127.0.0.1:" + server.address().port + "/",
    ], { timeout: 30000, windowsHide: true });
    const result = /<output id="result">([^<]*)<\/output>/.exec(stdout)?.[1];
    if (result === "NO_WEBGL") { t.skip("Installed browser did not provide a WebGL context"); return; }
    assert.equal(result, "PASS", result || "Chromium did not finish the WebGL fixture");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
