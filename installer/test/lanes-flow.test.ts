import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectLanes, type LanesInput } from "../src/lanes-wizard.ts";
import { parseArgs } from "../src/args.ts";
import { main } from "../src/run.ts";
import { listCheckouts } from "../src/repos-scan.ts";
import { CANCEL, type Ctx, type Prompter } from "../src/types.ts";
import { assertTempHome, REPO, tempDir, testCtx } from "./helpers/home.ts";
function scripted(answers: unknown[]) {
  const questions: string[] = []; const selects: string[][] = []; const notes: string[] = [];
  const next = (message: string) => { questions.push(message); assert.ok(answers.length, `missing answer: ${message}`); return Promise.resolve(answers.shift() as never); };
  const p: Prompter = { intro: () => {}, outro: () => {}, note: (body) => notes.push(body), spinner: () => ({ start: () => {}, stop: () => {} }),
    confirm: (o) => next(o.message), select: (o) => { selects.push(o.options.map((x) => x.value)); return next(o.message); },
    text: (o) => next(o.message), multiselect: (o) => next(o.message), isCancel: (v) => v === CANCEL };
  return { p, questions, selects, notes };
}
function fixture() {
  const home = assertTempHome(tempDir("lanes-flow")); const out: string[] = []; const err: string[] = [];
  const input: LanesInput = { home, reposRoot: join(home, "repos"), existingIds: ["L0", "L1", "L3"],
    checkouts: [{ repo: "example/alpha", path: join(home, "repos/alpha") }, { repo: "example/beta", path: join(home, "repos/beta") }],
    issues: async () => [{ number: 1, title: "First", mine: false }, { number: 2, title: "Mine", mine: true }] };
  const ctx: Ctx = { home, env: { HOME: home }, cwd: home, repoDir: REPO, platform: "linux", now: () => new Date(), stdinTTY: true, stdoutTTY: true, nodeVersion: "22.19.0", out: (s) => out.push(s), err: (s) => err.push(s), which: () => undefined, run: async () => { throw new Error("unexpected process"); } };
  return { input, ctx, home, out, err };
}
test("guided choices skip occupied ids, put mine first, select an issue and a goal", async () => {
  const { input } = fixture(); const dir = join(input.reposRoot, ".lanes");
  const s = scripted([dir, input.checkouts.map((c) => c.path), "2", "goal", "Fix it", true]);
  const result = await collectLanes(s.p, input); assert.ok(result !== CANCEL);
  assert.deepEqual(result.lanes.map((l) => [l.id, l.issue, l.goal]), [["L2", 2, undefined], ["L4", undefined, "Fix it"]]);
  assert.deepEqual(s.selects[1], ["2", "1", "goal", "skip"]);
  assert.match(s.notes.at(-1)!, /Worktrees:/);
});
test("goal fallback notes once per repo, skip repository and other folder expands HOME", async () => {
  const { input } = fixture();
  const skipped = scripted([input.checkouts.map((c) => c.path), "skip", "1", true]);
  const result = await collectLanes(skipped.p, { ...input, dir: input.home }); assert.ok(result !== CANCEL); assert.equal(result.lanes.length, 1); assert.equal(result.lanes[0].repo, "example/beta");
  const fallback = scripted(["other", "~/coord", [input.checkouts[0].path], "A goal", true]);
  const goal = await collectLanes(fallback.p, { ...input, issues: async () => undefined }); assert.ok(goal !== CANCEL);
  assert.equal(goal.dir, join(input.home, "coord")); assert.equal(goal.lanes[0].goal, "A goal");
  assert.equal(fallback.notes.filter((n) => n.startsWith("No issues")).length, 1);
});
test("all prompt steps honor CANCEL including other folder, goal and preview", async () => {
  const { input } = fixture();
  const scenarios = [[join(input.reposRoot, ".lanes"), [input.checkouts[0].path], "goal", "A goal", true], ["other", join(input.home, "elsewhere"), [input.checkouts[0].path], "1", true]];
  for (const answers of scenarios) for (let i = 0; i < answers.length; i++) {
    const a = [...answers]; a[i] = CANCEL; const s = scripted(a);
    assert.equal(await collectLanes(s.p, input), CANCEL); assert.equal(s.questions.length, i + 1);
  }
  const noRepos = scripted([[]]); assert.equal(await collectLanes(noRepos.p, { ...input, dir: input.home, checkouts: [] }), CANCEL);
  const skipped = scripted([[input.checkouts[0].path], "skip"]); assert.equal(await collectLanes(skipped.p, { ...input, dir: input.home }), CANCEL);
});
test("lanes args are isolated and relative --dir resolves against cwd", () => {
  const parsed = parseArgs(["lanes", "--dir", "space dir"], "/base"); assert.ok(parsed.ok); assert.equal(parsed.options.dir, "/base/space dir");
  const home = parseArgs(["lanes", "--dir", "~/coord"], "/base"); assert.ok(home.ok); assert.equal(home.options.dir, "~/coord");
  for (const args of [["--dir", "x"], ["doctor", "--dir", "x"], ["lanes", "--yes"], ["lanes", "--with", "lanes"], ["lanes", "--dir"]]) assert.equal(parseArgs(args, "/base").ok, false);
});
test("noninteractive lanes explains scripts; interactive uninstalled lanes errors without spawning", async () => {
  const { ctx, out, err } = fixture();
  assert.equal(await main(["lanes"], { ...ctx, stdinTTY: false }), 1); assert.match(out.pop()!, /in scripts use lanes init/);
  assert.equal(await main(["lanes"], ctx, scripted([]).p), 1); assert.match(err.pop()!, /lanes is not installed/);
});
test("checkout discovery handles two levels, validates origins and caps results", () => {
  const { home } = fixture();
  for (const [path, url] of [["alpha", "git@example.invalid:example/alpha.git"], ["org/beta", "https://example.invalid/example/beta.git"], [".lanes/hidden", "https://example.invalid/example/hidden"], [".worktrees/wt", "https://example.invalid/example/wt"], ["bad", "not-a-repo"], ["deep/org/ignored", "https://example.invalid/example/ignored"]]) {
    mkdirSync(join(home, path, ".git"), { recursive: true }); writeFileSync(join(home, path, ".git/config"), `[remote "origin"]\n url = ${url}\n`);
  }
  assert.deepEqual(listCheckouts(home).map((c) => c.repo).sort(), ["example/alpha", "example/beta"]);
  assert.equal(listCheckouts(home, 1).length, 1);
});

test("post-install lanes offer is separate, default-no and gated on a real interactive install", async () => {
  for (const mode of ["decline", "cancel", "yes", "dry", "plan", "without", "existing", "accept-cancel"]) {
    const home = assertTempHome(tempDir("lanes-offer")); const repos = join(home, "repos"); const questions: { message: string; initial: boolean }[] = [];
    if (mode === "existing") { mkdirSync(join(repos, ".lanes"), { recursive: true }); writeFileSync(join(repos, ".lanes/lanes.json"), "{}"); }
    const ctx = testCtx(home, { stdinTTY: true, stdoutTTY: true, which: (name) => ["python3", "git"].includes(name) ? `/stub/${name}` : undefined });
    const p: Prompter = { intro: () => {}, outro: () => {}, note: () => {}, spinner: () => ({ start: () => {}, stop: () => {} }),
      text: async () => { throw new Error("unexpected text"); }, select: async () => CANCEL,
      multiselect: async (o) => o.initial as never, isCancel: (v) => v === CANCEL,
      confirm: async (o) => { questions.push({ message: o.message, initial: o.initial }); return o.message === "Set up a coordinator and lanes now?" ? mode === "cancel" ? CANCEL : mode === "accept-cancel" : true; } };
    const args = ["--user", "tester", "--repos-root", repos, "--profile", "balanced", "--skip-npm", ...(mode === "without" ? ["--without", "lanes"] : ["--with", "lanes"]),
      ...(mode === "yes" ? ["--yes"] : mode === "dry" ? ["--dry-run"] : mode === "plan" ? ["--plan"] : [])];
    assert.equal(await main(args, ctx, p), 0, mode);
    const offers = questions.filter((q) => q.message === "Set up a coordinator and lanes now?");
    assert.equal(offers.length, ["decline", "cancel", "accept-cancel"].includes(mode) ? 1 : 0, mode);
    if (offers.length) assert.equal(offers[0].initial, false);
    if (mode !== "existing") assert.equal(existsSync(join(repos, ".lanes/lanes.json")), false, mode);
  }
});
