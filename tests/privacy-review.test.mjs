import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../browser-extension/privacy-review.js", import.meta.url), "utf8");

function load() {
  const context = { URL, Date, String, Boolean, Error, Promise, Object, Array, document: undefined };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.UIQuarryPrivacyReview;
}

test("privacy review rejects incomplete export metadata", () => {
  const api = load();
  assert.equal(api.isComplete({ license: "MIT", sourceReviewed: false, reviewedAt: new Date().toISOString() }), false);
  assert.throws(() => api.manifestMetadata({ license: "MIT", sourceReviewed: false }), /完成来源和授权审核/);
});

test("completed review metadata keeps source provenance and selected license", () => {
  const api = load();
  const reviewedAt = "2026-11-20T09:00:00.000Z";
  const metadata = api.manifestMetadata({
    license: "MIT",
    licenseId: "MIT",
    sourceReviewed: true,
    reviewedAt,
    sourceUrl: "https://example.test/components/card"
  });
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.sourceUrl, "https://example.test/components/card");
  assert.deepEqual(Object.keys(metadata).sort(), ["license", "sourceUrl"]);
});

