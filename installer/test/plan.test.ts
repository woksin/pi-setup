import { strict as assert } from "node:assert";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { apply } from "../src/apply.ts";
import { buildPlan } from "../src/plan.ts";
import { overlayFor } from "../src/profiles.ts";
import type { Ctx } from "../src/types.ts";
import { assertTempHome, REPO } from "./helpers/home.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const settings = { githubUser: "einari", reposRoot: "/tmp/r" };

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "pisetup-plan."));
  roots.push(root);
  return assertTempHome(root);
}
const plan = (h: string, profile = "balanced") =>
  buildPlan({ repoDir: REPO, home: h, settings, overlay: overlayFor(REPO, profile, settings) });
const ctxFor = (h: string, lines: string[] = []): Ctx => ({
  env: {}, platform: "linux", home: h, cwd: REPO, repoDir: REPO, now: () => new Date(2026, 0, 2, 3, 4, 5),
  run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), which: () => undefined,
  stdinTTY: false, stdoutTTY: false, nodeVersion: "v22.19.0", out: (l) => lines.push(l), err: () => {},
});
const opts = { dryRun: false, skipNpm: true, inheritNpm: false, profile: "balanced", activeBefore: undefined };

test("a clean plan starts with user.json and installs rendered files; applying it leaves an empty re-plan", async () => {
  const h = home();
  const actions = plan(h);
  assert.equal(actions[0].path, join(h, ".pi/agent/user.json"));
  assert.equal((await apply(ctxFor(h), actions, opts)).code, 0);
  assert.deepEqual([...new Set(plan(h).map((a) => a.op))].sort(), ["adopt", "chmod-x"]);
  assert.match(readFileSync(join(h, ".pi/agent/AGENTS.md"), "utf8"), /--add-assignee einari/);
  assert.ok(statSync(join(h, ".pi/agent/local-packages/pi-questions/dist/cli.js")).mode & 0o100);
  assert.ok(lstatSync(join(h, ".pi/agent/skills/ai-work-lifecycle")).isSymbolicLink());
});

test("config.local.json is never installed or overwritten, even if present in the source", async () => {
  const h = home();
  const source = join(h, "source");
  mkdirSync(join(source, "agent"), { recursive: true });
  for (const entry of readdirSync(join(REPO, "agent"))) {
    const dest = join(source, "agent", entry);
    if (entry === "pi-phase") cpSync(join(REPO, "agent", entry), dest, { recursive: true });
    else symlinkSync(join(REPO, "agent", entry), dest);
  }
  for (const entry of ["skills", "tools"]) symlinkSync(join(REPO, entry), join(source, entry));
  writeFileSync(join(source, "agent/pi-phase/config.local.json"), '{"heavy_slots":31}');
  const local = join(h, ".pi/agent/pi-phase/config.local.json");
  const fresh = buildPlan({ repoDir: source, home: h, settings, overlay: overlayFor(REPO, "balanced", settings) });
  assert.ok(!fresh.some(a => a.path === local));
  mkdirSync(join(h, ".pi/agent/pi-phase"), { recursive: true });
  writeFileSync(local, '{"heavy_slots":7}');
  assert.equal((await apply(ctxFor(h), fresh, opts)).code, 0);
  assert.equal(readFileSync(local, "utf8"), '{"heavy_slots":7}');
  assert.ok(!plan(h).some(a => a.path === local));
  const manifest = JSON.parse(readFileSync(join(h, ".pi/agent/.pi-setup/manifest.json"), "utf8"));
  assert.ok(!manifest.files[".pi/agent/pi-phase/config.local.json"]);
});

test("pi-phase policy paths render from reposRoot as valid JSON without changing other settings", () => {
  const reposRoot = '/tmp/my "repositories"';
  const renderedSettings = { ...settings, reposRoot };
  const actions = buildPlan({ repoDir: REPO, home: home(), settings: renderedSettings, overlay: overlayFor(REPO, "balanced", renderedSettings) });
  const action = actions.find((a) => a.op === "install" && a.path.endsWith("/pi-phase/config.json"));
  assert.ok(action?.op === "install");
  const text = action.content.toString("utf8");
  assert.ok(!text.includes("{{REPOS_ROOT}}"));
  const rendered = JSON.parse(text);
  assert.deepEqual(
    rendered.policy.map((rule: { path: string }) => rule.path),
    ["Specifications*", "Fundamentals*", ".worktrees/fundamentals*", ".worktrees/spec*"].map((suffix) => `${reposRoot}/cratis/${suffix}`),
  );
  for (const rule of rendered.policy) assert.deepEqual({ ...rule, path: undefined }, { path: undefined, kinds: ["build", "test"], policy: "direct", max_expected_s: 90 });
  const source = JSON.parse(readFileSync(join(REPO, "agent/pi-phase/config.json"), "utf8"));
  delete rendered.policy;
  delete source.policy;
  assert.deepEqual(rendered, source);
});

test("the overlay puts the chosen profile's agents live; other profile files stay in profiles/", async () => {
  const h = home();
  await apply(ctxFor(h), plan(h, "openai-only"), { ...opts, profile: "openai-only" });
  const dir = join(REPO, "agent/profiles/openai-only/agents");
  for (const f of readdirSync(dir)) assert.equal(readFileSync(join(h, ".pi/agent/agents", f), "utf8"), readFileSync(join(dir, f), "utf8"));
  assert.ok(existsSync(join(h, ".pi/agent/profiles/balanced/profile.json")));
  assert.equal(readFileSync(join(h, ".pi/agent/profiles/ACTIVE"), "utf8"), "openai-only\n");
});

test("changed files are backed up with one timestamp; dry-run prints and writes nothing", async () => {
  const h = home();
  mkdirSync(join(h, ".pi/agent"), { recursive: true });
  writeFileSync(join(h, ".pi/agent/AGENTS.subagent.md"), "old");
  const lines: string[] = [];
  await apply(ctxFor(h, lines), plan(h), { ...opts, dryRun: true });
  assert.ok(lines.includes(`install ${join(h, ".pi/agent/AGENTS.subagent.md")}`));
  assert.equal(readFileSync(join(h, ".pi/agent/AGENTS.subagent.md"), "utf8"), "old");
  await apply(ctxFor(h), plan(h), opts);
  assert.equal(readFileSync(join(h, ".pi/agent/.pi-setup/backups/20260102-030405/AGENTS.subagent.md"), "utf8"), "old");
  assert.deepEqual(readdirSync(join(h, ".pi/agent")).filter((n) => n.includes(".bak-")), []);
});

test("only-if-absent files are not overwritten and settings.json gets pi-questions registered once", async () => {
  const h = home();
  mkdirSync(join(h, ".pi/agent"), { recursive: true });
  writeFileSync(join(h, ".pi/agent/settings.json"), '{"keep":true,"packages":["a"]}');
  const actions = plan(h);
  assert.equal(actions.filter((a) => a.op === "register").length, 1);
  assert.ok(!actions.some((a) => a.op === "install" && a.path.endsWith("/settings.json")));
  await apply(ctxFor(h), actions, opts);
  const settingsJson = JSON.parse(readFileSync(join(h, ".pi/agent/settings.json"), "utf8"));
  assert.deepEqual(settingsJson, { keep: true, packages: ["a", "npm:@woksin/pi-jobs@0.3.1", "npm:@woksin/pi-context-budget@0.5.0", "npm:@woksin/pi-recover@0.1.1", "npm:@woksin/pi-orch@0.1.1", "./local-packages/pi-questions"] });
  assert.equal(plan(h).filter((a) => a.op === "register").length, 0);
});

test("a dangling skills symlink does not crash the plan", () => {
  const h = home();
  mkdirSync(join(h, ".pi/agent/skills"), { recursive: true });
  symlinkSync("/nonexistent-target", join(h, ".pi/agent/skills/ai-work-lifecycle"));
  assert.ok(!plan(h).some((a) => a.op === "symlink" && a.path.endsWith("/skills/ai-work-lifecycle")));
});

test("sol-loop ships SKILL.md and its LICENSE to ~/.agents/skills", async () => {
  const h = home();
  await apply(ctxFor(h), plan(h), opts);
  for (const f of ["SKILL.md", "LICENSE"]) {
    assert.equal(readFileSync(join(h, ".agents/skills/sol-loop", f), "utf8"), readFileSync(join(REPO, "skills/sol-loop", f), "utf8"));
  }
});
