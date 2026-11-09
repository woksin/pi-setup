import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  test(`${path}: fit measures the arranged result including reviewerLines`, () => {
    const fit = loadFit(path);
    const reviewers = Array.from({ length: 12 }, (_, i) => ({ label: `review:long-label-number-${i}`, effective: ["provider/some-long-model-name"], ok: true, expected: "provider/some-long-model-name", assistants: 3 }));
    const blocking = Array.from({ length: 6 }, (_, i) => `(major) file${i}.ts:1: ${"x".repeat(120)}`);
    const budget = 2800; // reachable only when reviewerLines are counted while shrinking
    const out = fit({ passed: false, blocking, reviewers: structuredClone(reviewers) }, budget);
    assert.ok(Array.isArray(out.reviewerLines));
    assert.ok(JSON.stringify(out).length <= budget, `result ${JSON.stringify(out).length} > ${budget}`);
  });
}
