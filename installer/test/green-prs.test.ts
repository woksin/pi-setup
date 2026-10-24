import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tempDir } from "./helpers/home.ts";
import { defaults } from "../src/lanes/config.ts";
import { greenPrs } from "../src/lanes/commands/green-prs.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";

const head = "a".repeat(40), base = "b".repeat(40), main = "c".repeat(40);
const pr = (number = 1) => ({ number, headRefOid: head, isDraft: false, labels: [], statusCheckRollup: [{ conclusion: "SUCCESS" }] });
type Options = { overlap?: boolean; failed?: boolean; truncated?: boolean; checksHead?: string; count?: number; moved?: boolean };
function apiFixture(path: string, options: Options): unknown {
  if (path.includes("check-runs")) return { total_count: 1, check_runs: [{ head_sha: options.checksHead ?? head, status: "completed", conclusion: "success" }] };
  if (path.includes("main...")) return { merge_base_commit: { sha: base }, base_commit: { sha: main } };
  if (path.includes("/files?")) return Array.from({ length: options.truncated ? 100 : 1 }, () => ({ filename: "src/changed.ts", previous_filename: "src/old.ts" }));
  if (path.includes("/pulls/")) return { head: { sha: options.moved ? main : head } };
  return { files: [{ filename: options.overlap === false ? "src/unrelated.ts" : "src/old.ts" }] };
}
function fixture(options: Options = {}) {
  const root = tempDir("green-prs"), out: string[] = [], calls: string[][] = [];
  const config = defaults(root, root, join(root, "repos")); config.github!.repos = ["example/repo"];
  const ctx = {
    which: () => "/stub/gh", out: (line: string) => out.push(line), err: () => {},
    run: async (_cmd: string, args: string[], opts: { timeoutMs?: number }) => {
      calls.push(args); assert.ok(opts.timeoutMs! <= 30000);
      const path = args[1];
      const value = args[0] === "pr" ? Array.from({ length: options.count ?? 1 }, (_, i) => pr(i + 1)) : apiFixture(path, options);
      return { code: options.failed && args[0] === "api" ? 1 : 0, stdout: JSON.stringify(value), stderr: "stub failure", timedOut: false };
    },
  } as unknown as LanesCtx;
  return { root, out, calls, config, ctx };
}

test("green PR overlapping main changes are stale, with CI SHA and actionable recommendation", async () => {
  const f = fixture(); assert.equal(await greenPrs({}, f.config, f.root, f.ctx), 0);
  assert.match(f.out[0], /stale: main changed 1 overlapping files since CI/);
  assert.match(f.out[0], /CI head aaaaaaaaaaaa/);
  assert.match(f.out[0], /merge main \+ rerun CI \+ review before merging/);
  assert.equal(f.calls.length, 6);
  assert.ok(f.calls.some((a) => a[1] === `repos/example/repo/compare/${base}...${main}`));
});

test("non-overlapping main paths are fresh", async () => {
  const f = fixture({ overlap: false }); await greenPrs({}, f.config, f.root, f.ctx);
  assert.match(f.out[0], /fresh: no overlapping main changes/);
});

test("API failure, incomplete files or mismatched CI head fail soft to unknown, never fresh", async () => {
  for (const options of [{ failed: true }, { truncated: true }, { checksHead: "d".repeat(40) }, { moved: true }]) {
    const f = fixture(options); assert.equal(await greenPrs({}, f.config, f.root, f.ctx), 0);
    assert.match(f.out[0], /staleness unknown/); assert.doesNotMatch(f.out[0], /fresh:/);
  }
});

test("API budget is bounded across PRs, and ack stays reference-only without comparisons", async () => {
  const f = fixture({ count: 7 }); await greenPrs({}, f.config, f.root, f.ctx);
  assert.equal(f.calls.filter((a) => a[0] === "api").length, 20);
  assert.match(f.out[0], /example\/repo#7 — staleness unknown/);
  f.calls.length = 0;
  await greenPrs({ ack: "true" }, f.config, f.root, f.ctx);
  assert.equal(f.calls.length, 1); assert.equal(f.out.at(-1), "acked 7");
  assert.equal(await greenPrs({ new: "true" }, f.config, f.root, f.ctx), 1);
});
