import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const files = ["workflows/review.js", ...["balanced-anthropic", "balanced-openai", "balanced", "lean"].map(p => `profiles/${p}/workflows/review.js`)];

/** Load fit() from a workflow script (top-level await/return prevents importing it). */
function loadFit(path: string): (res: Record<string, unknown>, budget?: number) => Record<string, unknown> {
  const source = readFileSync(new URL(path, root), "utf8");
  const cut = (from: string, to: string) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `${path}: ${from} section found`);
    return source.slice(start, end);
  };
  const code = [cut("const trimRuntimeDetails", "// End runtime recording."), cut("const LEAD_KEYS", "// Cache identities"),
    cut("const clip =", "const oneLine"), cut("const oneLine", "// Security holes"), cut("const fit =", "const ADVISORY_MAX")].join("\n");
  return new Function(`${code}\nreturn fit`)();
}

for (const path of files) {
  // The test sandbox installs agent/ only; profile copies are checked in the repo checkout.
  test(`${path}: fit measures the pretty-printed arranged result`, { skip: !existsSync(new URL(path, root)) }, () => {
    const fit = loadFit(path);
    const reviewers = Array.from({ length: 12 }, (_, i) => ({ label: `review:long-label-number-${i}`, effective: ["provider/some-long-model-name"], ok: true, expected: "provider/some-long-model-name", assistants: 3 }));
    const blocking = Array.from({ length: 6 }, (_, i) => `(major) file${i}.ts:1: ${"x".repeat(120)}`);
    const budget = 2800; // reachable only by dropping reviewerLines or compacting reviewers
    const out = fit({ passed: false, blocking, reviewers: structuredClone(reviewers) }, budget);
    assert.ok(JSON.stringify(out, null, 2).length <= budget, "pretty-printed length");
    assert.ok(out.reviewerLines === undefined || Array.isArray(out.reviewerLines));
  });
}
