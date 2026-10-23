import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { install, piPath, REPO, sandbox, snapshot, tempDir, testCtx } from "./helpers/home.ts";
import { available, detectDefaults, hintFor, COMPONENTS } from "../src/components.ts";
import { buildPlan } from "../src/plan.ts";
import { overlayFor } from "../src/profiles.ts";
import { emptyManifest, readManifest } from "../src/manifest.ts";
import { retireSymlinks } from "../src/uninstall.ts";
import { main as installerMain } from "../src/run.ts";
import { defaults } from "../src/lanes/config.ts";
import { CANCEL, type Prompter } from "../src/types.ts";
import { localChecks } from "../src/doctor-checks.ts";
import { componentChecks } from "../src/doctor-components.ts";

const settings = { githubUser: "tester", reposRoot: "/tmp/repos" };
const target = (home: string, pkg: string, cmd: string) => join(home, ".pi/agent/npm/node_modules/@woksin", pkg, "bin", cmd);
const fakeTargets = (home: string) => {
  for (const [pkg, cmd] of [["pi-context-budget", "pi-session"], ["pi-orch", "orch"]]) {
    const path = target(home, pkg, cmd); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  }
};
const plan = (home: string, components?: Record<string, boolean>, notes: string[] = []) => buildPlan({ repoDir: REPO, home, settings, overlay: overlayFor(REPO, "balanced", settings), components, notes });
const args = ["--yes", "--user", "tester", "--skip-npm"];
function assertInstall(r: ReturnType<typeof install>): void { assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); }

test("lanes is opt-in, needs git, and has a wizard hint", () => {
  const home = tempDir("lanes-component"); const ctx = testCtx(home);
  assert.equal(available("lanes", ctx), "needs git");
  assert.equal(available("lanes", { ...ctx, which: () => "/stub/git" }), true);
  assert.equal(detectDefaults(ctx, { github: { orgs: [] } as never }, home).lanes, false);
  assert.match(hintFor(COMPONENTS.find((c) => c.id === "lanes")!, false), /opt-in/);
  assert.ok(!plan(home).some((a) => a.path.includes(".local/share/pi-setup/lanes")));
  assert.ok(plan(home, { lanes: true }).some((a) => a.op === "symlink" && a.path.endsWith("/bin/lanes")));
});

test("link planning creates only free core links and leaves files and foreign links with notes", () => {
  const home = tempDir("lanes-link-plan"); fakeTargets(home);
  let actions = plan(home);
  assert.equal(actions.filter((a) => a.op === "symlink" && /\/bin\/(pi-session|orch)$/.test(a.path)).length, 2);
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/pi-session"), "mine"); symlinkSync("/foreign", join(home, ".local/bin/orch"));
  const notes: string[] = []; actions = plan(home, { lanes: true }, notes);
  assert.equal(actions.filter((a) => a.op === "symlink" && /\/bin\/(pi-session|orch)$/.test(a.path)).length, 0);
  assert.ok(notes.includes("left ~/.local/bin/pi-session: a file; pi-setup does not replace it"));
  assert.ok(notes.includes("left ~/.local/bin/orch: a link to /foreign; pi-setup does not replace it"));
  unlinkSync(join(home, ".local/bin/orch")); symlinkSync(target(home, "pi-orch", "orch"), join(home, ".local/bin/orch"));
  const sameNotes: string[] = []; plan(home, undefined, sameNotes); assert.ok(!sameNotes.some((n) => n.includes("/orch:")));
});

test("sandbox install records lanes, finds installed templates, preserves MCP choice and retires lanes", () => {
  const box = sandbox();
  try {
    assertInstall(install(box, [...args, "--with", "lanes"]));
    const dir = join(box.home, ".local/share/pi-setup/lanes"); const bin = join(box.home, ".local/bin/lanes");
    assert.equal(readlinkSync(bin), join(dir, "lanes.mjs")); assert.ok(existsSync(join(dir, "templates/lane.md")));
    const m = readManifest(piPath(box))!; assert.ok(m.files[".local/share/pi-setup/lanes/lanes.mjs"]?.sha256);
    assert.deepEqual(m.symlinks[".local/bin/lanes"], { target: ".local/share/pi-setup/lanes/lanes.mjs" });
    const run = (...argv: string[]) => spawnSync(process.execPath, [bin, ...argv], { env: { HOME: box.home, PATH: box.stubs }, encoding: "utf8", timeout: 60000 });
    assert.equal(run("--help").status, 0);
    const root = join(box.home, "coord"); assert.equal(run("init", root).status, 0);
    const configPath = join(root, "lanes.json"); const c = JSON.parse(readFileSync(configPath, "utf8")); assert.equal(c.launch.preapproveMcp, false);
    c.launch.preapproveMcp = true; writeFileSync(configPath, JSON.stringify(c));
    assertInstall(install(box, [...args, "--with", "lanes"]));
    assert.equal(run("init", root).status, 0); assert.equal(JSON.parse(readFileSync(configPath, "utf8")).launch.preapproveMcp, true);
    assert.ok(!readFileSync(join(root, "prompts/coordinator.md"), "utf8").includes("{{"));
    assertInstall(install(box, [...args, "--without", "lanes"]));
    assert.ok(!existsSync(join(dir, "lanes.mjs"))); assert.throws(() => lstatSync(bin));
    const off = readManifest(piPath(box))!; assert.equal(off.components?.lanes.on, false); assert.ok(!off.symlinks[".local/bin/lanes"]);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).launch.preapproveMcp, true);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test("core wrapper links are recorded, survive lanes retirement, and uninstall only removes matching links", () => {
  const box = sandbox();
  try {
    fakeTargets(box.home);
    assertInstall(install(box, [...args, "--with", "lanes"]));
    const m = readManifest(piPath(box))!;
    for (const [pkg, cmd] of [["pi-context-budget", "pi-session"], ["pi-orch", "orch"]]) {
      assert.equal(readlinkSync(join(box.home, ".local/bin", cmd)), target(box.home, pkg, cmd));
      assert.equal(m.symlinks[`.local/bin/${cmd}`].target, `.pi/agent/npm/node_modules/@woksin/${pkg}/bin/${cmd}`);
    }
    const checks = localChecks(testCtx(box.home), { providers: {}, catalog: null, head: m.source.commit || undefined, checkoutClean: false, summary: false }).checks;
    assert.equal(checks.find((c) => c.id === "files")?.status, "ok");
    const orch = join(box.home, ".local/bin/orch"); unlinkSync(orch); symlinkSync("/foreign", orch);
    const rerun = install(box, [...args, "--without", "lanes"]); assertInstall(rerun); assert.match(rerun.stdout + rerun.stderr, /left ~\/\.local\/bin\/orch: a link to \/foreign/);
    assert.ok(existsSync(join(box.home, ".local/bin/pi-session")));
    const un = spawnSync(process.execPath, [join(REPO, "installer/dist/pi-setup.mjs"), "uninstall", "--yes"], { env: { HOME: box.home, PATH: box.stubs }, encoding: "utf8", timeout: 60000 });
    assert.equal(un.status, 0, un.stderr); assert.throws(() => lstatSync(join(box.home, ".local/bin/pi-session"))); assert.equal(readlinkSync(orch), "/foreign");
    assert.equal(readFileSync(target(box.home, "pi-context-budget", "pi-session"), "utf8"), "#!/bin/sh\nexit 99\n");
    assert.ok(existsSync(target(box.home, "pi-orch", "orch")));
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test("sandbox installer never replaces an existing wrapper file or foreign link", () => {
  const box = sandbox();
  try {
    fakeTargets(box.home); mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    const bin = join(box.home, ".local/bin"); writeFileSync(join(bin, "pi-session"), "mine"); symlinkSync("/foreign", join(bin, "orch"));
    const r = install(box, args); assertInstall(r);
    assert.match(r.stdout + r.stderr, /left ~\/\.local\/bin\/pi-session: a file/);
    assert.match(r.stdout + r.stderr, /left ~\/\.local\/bin\/orch: a link to \/foreign/);
    assert.equal(readFileSync(join(bin, "pi-session"), "utf8"), "mine"); assert.equal(readlinkSync(join(bin, "orch")), "/foreign");
    const m = readManifest(piPath(box))!; assert.ok(!m.symlinks[".local/bin/pi-session"]); assert.ok(!m.symlinks[".local/bin/orch"]);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test("retireSymlinks drops records and leaves changed links with a line", async () => {
  const home = tempDir("lanes-retire-links"); const m = emptyManifest(new Date()); const ctx = testCtx(home);
  mkdirSync(join(home, ".local/bin"), { recursive: true }); const path = join(home, ".local/bin/lanes");
  m.symlinks[".local/bin/lanes"] = { target: ".local/share/pi-setup/lanes/lanes.mjs" };
  symlinkSync("/foreign", path);
  const steps = retireSymlinks(ctx, m, [".local/bin/lanes"]); assert.equal(steps.length, 1); assert.match(steps[0].line, /left .*no longer points at/);
  await steps[0].run(); assert.equal(readlinkSync(path), "/foreign"); assert.ok(!m.symlinks[".local/bin/lanes"]);
  unlinkSync(path); symlinkSync(join(home, ".local/share/pi-setup/lanes/lanes.mjs"), path);
  m.symlinks[".local/bin/lanes"] = { target: ".local/share/pi-setup/lanes/lanes.mjs" };
  for (const step of retireSymlinks(ctx, m, [".local/bin/lanes"])) await step.run(); assert.throws(() => lstatSync(path));
  const protectedTarget = target(home, "pi-orch", "orch"); fakeTargets(home);
  const wrapper = join(home, ".local/bin/orch"); symlinkSync(protectedTarget, wrapper);
  m.symlinks[".local/bin/orch"] = { target: ".pi/agent/npm/node_modules/@woksin/pi-orch/bin/orch" };
  for (const step of retireSymlinks(ctx, m, [".local/bin/orch"])) await step.run();
  assert.throws(() => lstatSync(wrapper)); assert.equal(readFileSync(protectedTarget, "utf8"), "#!/bin/sh\nexit 99\n");
});

test("lanes doctor is read-only, detects backend, git, foreign links and MCP trust settings", async () => {
  const home = tempDir("lanes-doctor"); const m = emptyManifest(new Date()); m.components = { lanes: { on: true } };
  const ctx = testCtx(home, { cwd: home });
  const before = snapshot(home); const checks = await componentChecks(ctx, m); assert.deepEqual(snapshot(home), before);
  const get = (id: string) => checks.find((c) => c.id === id)!;
  assert.equal(get("lanes").status, "warn"); assert.equal(get("lanes").fix, "pi-setup install --with lanes"); assert.equal(get("lanes-git").status, "warn"); assert.match(get("lanes-terminal").detail, /^print \(no Terminal.app/);
  assert.match(get("lanes-preapprove-mcp").detail, /off/);
  const dir = join(home, ".local/share/pi-setup/lanes"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "lanes.mjs"), "test");
  mkdirSync(join(home, ".local/bin"), { recursive: true }); symlinkSync(join(dir, "lanes.mjs"), join(home, ".local/bin/lanes"));
  const good = await componentChecks(testCtx(home, { cwd: home, platform: "darwin", env: { TERM_PROGRAM: "iTerm.app" }, which: () => "/stub/git" }), m);
  assert.equal(good.find((c) => c.id === "lanes")?.status, "ok"); assert.equal(good.find((c) => c.id === "lanes-terminal")?.detail, "iterm");
  unlinkSync(join(home, ".local/bin/lanes")); symlinkSync("/foreign", join(home, ".local/bin/lanes"));
  const foreign = await componentChecks(ctx, m); assert.match(foreign.find((c) => c.id === "lanes")?.fix || "", /move ~\/\.local\/bin\/lanes away/);
});

test("installer trust opt-in is inherited by new folders and saved true survives reruns", async () => {
  const box = sandbox();
  try {
    assertInstall(install(box, [...args, "--with", "lanes", "--preapprove-mcp"]));
    const bin = join(box.home, ".local/bin/lanes");
    const run = (...argv: string[]) => spawnSync(process.execPath, [bin, ...argv], { env: { HOME: box.home, PATH: box.stubs }, encoding: "utf8", timeout: 60000 });
    const installed = join(box.home, ".local/share/pi-setup/lanes/defaults.json");
    assert.equal(JSON.parse(readFileSync(installed, "utf8")).launch.preapproveMcp, true);
    const root = join(box.home, "coord"); assert.equal(run("init", root).status, 0);
    const config = join(root, "lanes.json"); assert.equal(JSON.parse(readFileSync(config, "utf8")).launch.preapproveMcp, true);
    const c = JSON.parse(readFileSync(config, "utf8")); c.launch.preapproveMcp = false; writeFileSync(config, JSON.stringify(c));
    assertInstall(install(box, args));
    assert.equal(JSON.parse(readFileSync(installed, "utf8")).launch.preapproveMcp, true);
    assert.equal(run("init", root, "--preapprove-mcp").status, 0); assert.equal(JSON.parse(readFileSync(config, "utf8")).launch.preapproveMcp, false);
    const m = readManifest(piPath(box))!;
    const checks = await componentChecks(testCtx(box.home, { cwd: box.home }), m);
    assert.match(checks.find((c) => c.id === "lanes-preapprove-mcp")!.detail, /on.*trusts project MCP/);
    const off = await componentChecks(testCtx(box.home, { cwd: root }), m);
    assert.match(off.find((c) => c.id === "lanes-preapprove-mcp")!.detail, /off in/);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test("installer preserves an existing coordination folder's true trust choice without rewriting it", () => {
  const box = sandbox();
  try {
    const root = join(box.home, "existing"); mkdirSync(root);
    const c = defaults(root, box.home); c.launch.preapproveMcp = true;
    const config = join(root, "lanes.json"); writeFileSync(config, JSON.stringify(c)); const before = readFileSync(config);
    assertInstall(install(box, [...args, "--with", "lanes"], { env: { LANES_DIR: root } }));
    assert.ok(readFileSync(config).equals(before));
    assert.equal(JSON.parse(readFileSync(join(box.home, ".local/share/pi-setup/lanes/defaults.json"), "utf8")).launch.preapproveMcp, true);
  } finally { rmSync(box.root, { recursive: true, force: true }); }
});

test("wizard trust consent reaches installed defaults; declining and cancellation do not opt in", async () => {
  for (const consent of [true, false, CANCEL]) {
    const home = tempDir("lanes-wizard-install"); const lines: string[] = []; const errors: string[] = [];
    const ctx = testCtx(home, { stdinTTY: true, stdoutTTY: true, which: (n) => ["python3", "git"].includes(n) ? `/stub/${n}` : undefined }, lines, errors);
    const questions: string[] = [];
    const p: Prompter = {
      intro: () => {}, outro: () => {}, note: () => {}, spinner: () => ({ start: () => {}, stop: () => {} }),
      text: async () => { throw new Error("unexpected text"); }, select: async () => { throw new Error("unexpected select"); },
      multiselect: async (o) => o.initial as never,
      confirm: async (o) => { questions.push(o.message); return o.message.startsWith("Preapprove") ? consent : true; }, isCancel: (v) => v === CANCEL,
    };
    const code = await installerMain(["--user", "tester", "--repos-root", join(home, "repos"), "--profile", "balanced", "--with", "lanes", "--skip-npm"], ctx, p);
    assert.equal(code, consent === CANCEL ? 1 : 0, errors.join("\n")); assert.match(questions[0], /trusts project MCP server definitions/);
    const installed = join(home, ".local/share/pi-setup/lanes/defaults.json");
    if (consent === CANCEL) assert.ok(!existsSync(installed));
    else assert.equal(JSON.parse(readFileSync(installed, "utf8")).launch.preapproveMcp, consent);
  }
});
