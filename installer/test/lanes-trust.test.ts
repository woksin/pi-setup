import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneCtx } from "./lanes-terminal.test.ts";
import { defaults, validate, type Config, type Lane } from "../src/lanes/config.ts";
import { run } from "../src/lanes/commands/run.ts";
import { realpathSync } from "node:fs";

async function launch(setup: (c: Config, ctx: ReturnType<typeof laneCtx>, wt: string) => void, trust: boolean, id = "L1") {
  const out: string[] = []; const argv: string[][] = [];
  const ctx = laneCtx({ which: () => "/fake/pi-session", out: s => out.push(s), realpath: realpathSync, admissionInventory: async () => [{ pid: process.pid, ppid: 1, start: "owner", pi: false }],
    spawnInherited: (_e, args) => { argv.push(args); return { pid: 0, done: Promise.resolve({ code: 0, signal: null }), signal: () => {} }; } });
  const c = defaults(ctx.home, ctx.home); c.reposRoot = ctx.home; c.launch.approveProjectTrust = trust;
  mkdirSync(join(ctx.home, "prompts")); writeFileSync(join(ctx.home, c.coordinator.prompt), "x"); writeFileSync(join(ctx.home, "prompts/L1.md"), "x");
  const wt = join(ctx.home, ".worktrees", "repo-one"); mkdirSync(join(wt, ".pi"), { recursive: true }); writeFileSync(join(wt, ".pi/settings.json"), "{}");
  c.lanes.push({ id: "L1", repo: "o/repo", group: null, worktree: "repo-one", branch: "b", prompt: "prompts/L1.md" } as Lane);
  setup(c, ctx, wt); validate(c, ctx.home, ctx.home);
  assert.equal(await run(id, {}, c, ctx.home, ctx), 0);
  return { args: argv[0], out };
}
const prompt = (args: string[]) => args[args.length - 1];

test("approves lanes-created worktree when opted in", async () => {
  const r = await launch(() => {}, true);
  assert.equal(r.args[0], "--approve"); assert.match(prompt(r.args), /^@.*L1\.md$/);
  assert.ok(r.out.some(l => l.startsWith("project trust approved")));
});
test("default off keeps prompt and prints hint", async () => {
  const r = await launch(() => {}, false);
  assert.deepEqual(r.args, [prompt(r.args)]); assert.ok(r.out.some(l => /launch\.approveProjectTrust/.test(l)));
});
test("coordinator is never approved", async () => {
  const r = await launch(() => {}, true, "coordinator");
  assert.deepEqual(r.args, [prompt(r.args)]);
});
test("custom cwd lane is not approved", async () => {
  const r = await launch((c, _x, wt) => { c.lanes[0].cwd = wt; }, true);
  assert.deepEqual(r.args, [prompt(r.args)]);
});
test("symlinked worktree escaping worktreesDir is not approved", async () => {
  const r = await launch((c, ctx, wt) => {
    const outside = join(ctx.home, "outside"); mkdirSync(outside); const link = join(ctx.home, ".worktrees", "link");
    symlinkSync(outside, link); c.lanes[0].worktree = "link"; void wt;
  }, true);
  assert.deepEqual(r.args, [prompt(r.args)]);
});
test("validate rejects non-boolean approveProjectTrust and accepts absent", () => {
  const c = defaults("/tmp/x", "/tmp"); (c.launch as Record<string, unknown>).approveProjectTrust = "yes";
  assert.throws(() => validate(c), /approveProjectTrust/);
  delete c.launch.approveProjectTrust; validate(c);
});
