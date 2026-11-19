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

test("Chromium captures active CSS keyframes as bounded read-only metadata", {
  skip: !browser && "Set UIQUARRY_TEST_BROWSER to run the browser animation capture check",
}, async () => {
  const html = await readFile(new URL("./fixtures/waapi-capture.html", import.meta.url));
  const script = await readFile(new URL("../browser-extension/content.js", import.meta.url));
  const server = createServer((req, res) => {
    if (req.url === "/") res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    else if (req.url === "/content.js") res.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
    else res.writeHead(404).end();
  });
  const profile = await mkdtemp(join(tmpdir(), "uiquarry-waapi-test-"));
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const { stdout } = await promisify(execFile)(browser, [
      "--headless=new", "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--virtual-time-budget=3000", `--user-data-dir=${profile}`, "--dump-dom",
      `http://127.0.0.1:${server.address().port}/`,
    ], { timeout: 30000, windowsHide: true });
    const result = /<output id="result">([^<]*)<\/output>/.exec(stdout)?.[1];
    assert.equal(result, "PASS", result || "Chromium did not finish the WAAPI fixture");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
