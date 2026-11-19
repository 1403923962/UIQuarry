import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../browser-extension/canvas-recorder.js", import.meta.url), "utf8");

function harness({ startError = false, silentStop = false, supported = true } = {}) {
  let now = 0, timerId = 0, recorder, inputStream;
  const calls = [], timers = new Map();
  function setTimer(fn, delay) {
    timers.set(++timerId, { at: now + delay, fn });
    return timerId;
  }
  function tick(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  }
  class Target extends EventTarget {
    emit(name, props = {}) {
      const event = Object.assign(new Event(name), props);
      this.dispatchEvent(event);
      this["on" + name]?.(event);
    }
  }
  const document = Object.assign(new Target(), { hidden: false, visibilityState: "visible" });
  const window = new Target();
  const track = Object.assign(new Target(), {
    kind: "video", readyState: "live", muted: false, stopped: 0,
    stop() { this.readyState = "ended"; this.stopped++; },
  });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  class HTMLCanvasElement {
    isConnected = true;
    width = 64;
    height = 32;
    captureStream(rate) { calls.push(rate); return stream; }
  }
  class MediaRecorder extends Target {
    static isTypeSupported(type) { return supported && type.startsWith("video/webm"); }
    constructor(input, options) {
      super();
      recorder = this;
      inputStream = input;
      this.mimeType = options.mimeType;
      this.state = "inactive";
    }
    start() {
      if (startError) throw new Error("encoder unavailable");
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      if (!silentStop) queueMicrotask(() => this.emit("stop"));
    }
  }
  class FileReader extends Target {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(bytes => {
        this.result = "data:" + blob.type + ";base64," + Buffer.from(bytes).toString("base64");
        this.emit("load");
        this.emit("loadend");
      });
    }
  }
  const context = vm.createContext({
    window, document, HTMLCanvasElement, MediaRecorder, Blob, FileReader, DOMException, AbortController,
    performance: { now: () => now }, setTimeout: setTimer, clearTimeout: id => timers.delete(id), btoa,
  });
  vm.runInContext(source, context);
  return {
    record: () => context.UIQuarryRecorder.record(new HTMLCanvasElement()),
    chunk: data => recorder.emit("dataavailable", { data: new Blob([data], { type: "video/webm" }) }),
    tick, window, document, track, calls, stream,
    get timers() { return timers.size; },
    get inputStream() { return inputStream; },
    get recorder() { return recorder; },
  };
}

test("selected canvas records three seconds of local video without an audio source", async () => {
  const h = harness();
  const clip = h.record();
  assert.deepEqual(h.calls, [24]);
  assert.equal(h.inputStream, h.stream);
  h.chunk("example");
  h.tick(3000);
  const value = await clip;
  assert.equal(value.durationMs, 3000);
  assert.equal(value.mimeType, "video/webm");
  assert.equal(value.dataUrl, "data:video/webm;base64,ZXhhbXBsZQ==");
  assert.equal(h.track.readyState, "ended");
  assert.equal(h.timers, 0);
});

test("hidden document and navigation cancel without yielding a partial clip", async () => {
  for (const reason of ["hidden", "navigation"]) {
    const h = harness();
    const rejected = assert.rejects(h.record());
    h.chunk("partial");
    if (reason === "hidden") {
      h.document.hidden = true;
      h.document.visibilityState = "hidden";
      h.document.emit("visibilitychange");
    } else {
      h.window.emit("pagehide");
    }
    await rejected;
    assert.equal(h.track.readyState, "ended");
    assert.equal(h.timers, 0);
  }
});

test("encoding failures, empty recordings and byte overflow release owned tracks", async () => {
  for (const reason of ["start", "error", "empty", "size", "timeout"]) {
    const h = harness({ startError: reason === "start", silentStop: reason === "timeout" });
    const rejected = assert.rejects(h.record());
    if (reason === "error") h.recorder.emit("error", { error: new Error("encoder failed") });
    if (reason === "empty") h.tick(3000);
    if (reason === "size") h.chunk(new Uint8Array(3_000_001));
    if (reason === "timeout") h.tick(6000);
    await rejected;
    assert.equal(h.track.readyState, "ended", reason);
    assert.equal(h.timers, 0, reason);
  }
});
