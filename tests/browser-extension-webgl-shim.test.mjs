import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const hook = await readFile(new URL("../browser-extension/webgl-preserve.js", import.meta.url), "utf8");

function harness(withOffscreen = true) {
  const calls = [];
  function makeCanvas() {
    return class {
      getContext(...args) {
        const result = { receiver: this, args };
        calls.push(result);
        return result;
      }
    };
  }
  const globals = { HTMLCanvasElement: makeCanvas() };
  if (withOffscreen) globals.OffscreenCanvas = makeCanvas();
  globals.window = globals;
  vm.runInNewContext(hook, globals);
  return { calls, html: new globals.HTMLCanvasElement(), offscreen: withOffscreen && new globals.OffscreenCanvas() };
}

test("WebGL gets a preserved drawing buffer on both window canvas interfaces", () => {
  const { html, offscreen, calls } = harness();
  for (const canvas of [html, offscreen]) {
    for (const type of ["webgl", "webgl2", "experimental-webgl"]) {
      const result = canvas.getContext(type);
      assert.equal(result, calls.at(-1));
      assert.equal(result.receiver, canvas);
      assert.equal(result.args[0], type);
      assert.equal(result.args[1].preserveDrawingBuffer, true);
    }
  }
});

test("preservation overrides explicit false but does not mutate the caller's context attributes", () => {
  const { html } = harness();
  const inherited = { alpha: false };
  const opts = Object.create(inherited);
  Object.defineProperties(opts, {
    preserveDrawingBuffer: { value: false, enumerable: true },
    antialias: { get() { return this.alpha; } },
  });
  Object.freeze(opts);
  const provided = html.getContext("webgl", opts).args[1];
  assert.notEqual(provided, opts);
  assert.equal(provided.alpha, false);
  assert.equal(provided.antialias, false);
  assert.equal(provided.preserveDrawingBuffer, true);
  assert.equal(opts.preserveDrawingBuffer, false);
});

test("ordinary contexts retain exact argument count, references, and return semantics", () => {
  const { html, calls } = harness(false);
  assert.equal(html.getContext("2d").args.length, 1);
  const opts = Object.freeze({ alpha: false });
  for (const type of ["2d", "webgpu", "bitmaprenderer"]) {
    const result = html.getContext(type, opts, 37);
    assert.equal(result, calls.at(-1));
    assert.equal(result.receiver, html);
    assert.deepEqual(result.args, [type, opts, 37]);
    assert.equal(result.args[1], opts);
  }
});
