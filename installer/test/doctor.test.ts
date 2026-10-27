import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/run.ts";
import { emptyManifest, sha256 } from "../src/manifest.ts";
import { doctorExitCode, installSummary } from "../src/doctor.ts";
import { localChecks } from "../src/doctor-checks.ts";
import type { DoctorFacts } from "../src/doctor-checks.ts";
import type { Ctx, RunOptions } from "../src/types.ts";
import { piPath, sandbox, snapshot, testCtx } from "./helpers/home.ts";

function fixture(pythonVersion = "Python 3.12.0") {
  const box = sandbox();
  const pi = piPath(box);
  const put = (rel: string, text: string) => { const p = join(pi, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
  const file = put("agents/ops.md", "---\nmodel: kimi-coding/k3-256k\nextensions: provider-fallback\n---\n");
  chmodSync(file, 0o644);
  put("profiles/ACTIVE", "balanced\n");
  put("settings.json", JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-5-5", packages: [] }));
  put("npm/package.json", '{"dependencies":{"example":"1"}}');
  put("npm/node_modules/example/package.json", "{}");
  put("provider-fallback.json", JSON.stringify({ enabled: true, pairs: [["kimi-coding/k3-256k", "openai-codex/gpt-6.1-sol"]] }));
  put("bin/dev-doctor", "disk");
  const manifest = emptyManifest(new Date());
  manifest.source = { commit: "abc123", release: "v1" };
  manifest.files[".pi/agent/agents/ops.md"] = { sha256: sha256(readFileSync(file)), mode: 0o644, source: manifest.source, origin: "new" };
  const save = () => put(".pi-setup/manifest.json", JSON.stringify(manifest));
  save();
  put(".pi-setup/update-check.json", JSON.stringify({ checkedAt: new Date(2026, 0, 2, 3, 4, 5).toISOString(), latest: "v1" }));
  const calls: { cmd: string; args: string[]; options?: RunOptions }[] = [];
  const out: string[] = [];
  const facts: DoctorFacts = { providers: Object.fromEntries(["anthropic", "openai-codex", "kimi-coding"].map(p => [p, { status: "ready" }])), catalog: new Set(["anthropic/claude-opus-5-5", "kimi-coding/k3-256k", "openai-codex/gpt-6.1-sol"]), head: "abc123", checkoutClean: true, summary: false };
  const ctx = testCtx(box.home, { env: { PATH: [join(box.home, ".local/bin"), join(box.home, ".pi/agent/bin")].join(":") }, which: () => "/stub", run: async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    let stdout = "";
    if (cmd === "pi") stdout = args[0] === "auth" ? JSON.stringify(facts.providers[args[3]]) : args[0] === "--version" ? "1.0" : "provider model\n" + [...facts.catalog!].map(p => p.replace("/", " ")).join("\n");
    if (cmd === "gh") stdout = "Logged in to github.com account tester";
    if (cmd === "git") stdout = args.includes("status") ? "" : args.includes("rev-parse") ? "abc123" : args.includes("ls-remote") ? "hash\trefs/tags/v2" : "v1";
    if (cmd === "python3") stdout = args[0] === "--version" ? pythonVersion : JSON.stringify([{ id: "disk", severity: "info", evidence: "plenty free", suggest: "df -h ~" }]);
    return { code: 0, stdout, stderr: "", timedOut: false };
  } }, out);
  const checks = () => localChecks(ctx, facts).checks;
  return { box, pi, put, file, manifest, save, calls, out, facts, ctx, checks };
}

test("exit mapping includes skips", () => {
  for (const [status, code] of [["ok", 0], ["skip", 0], ["warn", 1], ["fail", 2]] as const) assert.equal(doctorExitCode([{ id: "a", title: "a", status, detail: "a" }]), code);
});

test("green JSON is one object; calls are bounded and restricted; HOME and guards stay untouched", async () => {
  const f = fixture();
  f.put("guards.json", '{"off":{"mcp":true}}'); f.put("guards.meta.json", "canary");
  const auth = f.put("auth.json", "canary");
  const authMode = statSync(auth).mode & 0o7777;
  const before = snapshot(f.box.home);
  chmodSync(auth, 0);
  assert.equal(await main(["doctor", "--json"], f.ctx), 0);
  chmodSync(auth, authMode);
  assert.deepEqual(snapshot(f.box.home), before);
  assert.equal(f.out.length, 1);
  assert.equal(JSON.parse(f.out[0]).version, 1);
  for (const c of f.calls) {
    assert.ok(c.options?.timeoutMs && c.options.timeoutMs <= 8000);
    assert.ok(!c.args.includes("--credentials"));
    if (c.cmd === "pi") assert.ok(c.args[0] === "--version" || c.args.join(" ") === "--offline --list-models" || /^auth check --provider \S+ --no-refresh --json$/.test(c.args.join(" ")));
  }
});

for (const [version, status, exit] of [["Python 3.9.6", "ok", 0], ["Python 3.14.2", "ok", 0], ["Python 3.8", "warn", 1], ["", "warn", 1]] as const) {
  test(`doctor checks Python version: ${version || "unknown"}`, async () => {
    const f = fixture(version);
    assert.equal(await main(["doctor", "--json"], f.ctx), exit);
    const check = JSON.parse(f.out[0]).checks.find((c: { id: string }) => c.id === "python");
    assert.equal(check.status, status);
    assert.ok(check.detail.includes(version || "Python version unknown"));
    assert.match(check.detail, /requires Python >=3\.9/);
    assert.equal(f.calls.filter(c => c.cmd === "python3" && c.args[0] === "--version").length, 1);
  });
}

test("doctor previews differing first-install files without a manifest and writes nothing", async () => {
  const f = fixture();
  unlinkSync(join(f.pi, ".pi-setup/manifest.json"));
  f.put("pi-phase/config.json", '{"heavy_slots":7}');
  f.put("pi-phase/config.local.json", '{"heavy_slots":9}');
  f.put("bin/inbox-watch", "local inbox default\n");
  f.put("user.json", JSON.stringify({ githubUser: "tester", reposRoot: join(f.box.home, "repos") }));
  const wrapper = join(f.box.home, ".local/bin/ai-work-lifecycle");
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, "#!/bin/sh\nexec /custom/python3 lifecycle.py\n");
  const before = snapshot(f.box.home);
  assert.equal(await main(["doctor", "--json"], f.ctx), 1);
  const files = JSON.parse(f.out[0]).checks.find((c: { id: string }) => c.id === "files");
  assert.match(files.detail, /no install manifest; first install would overwrite/);
  for (const rel of [".pi/agent/pi-phase/config.json", ".pi/agent/bin/inbox-watch", ".local/bin/ai-work-lifecycle"]) assert.ok(files.items.includes(rel), rel);
  assert.ok(!files.items.includes(".pi/agent/pi-phase/config.local.json"));
  assert.deepEqual(snapshot(f.box.home), before);
});

test("doctor does not list identical first-install files or absent files as overwrites", () => {
  const f = fixture();
  unlinkSync(join(f.pi, ".pi-setup/manifest.json"));
  f.put("bin/inbox-watch", readFileSync(join(f.ctx.repoDir, "agent/bin/inbox-watch"), "utf8"));
  const files = f.checks().find(c => c.id === "files")!;
  assert.match(files.detail, /first install would overwrite/);
  assert.ok(!files.items?.includes(".pi/agent/bin/inbox-watch"));
  assert.ok(!files.items?.includes(".local/bin/ai-work-lifecycle"));
});

test("files: missing, modified, pending, modes and moved checkout", () => {
  const f = fixture();
  assert.equal(f.checks().find(c => c.id === "files")?.status, "ok");
  chmodSync(f.file, 0o755);
  assert.equal(f.checks().find(c => c.id === "modes")?.fixable, "chmod");
  writeFileSync(f.file, "edited");
  assert.match(f.checks().find(c => c.id === "files")!.detail, /changed by you/);
  f.manifest.pendingNew = { ".pi/agent/agents/ops.md.pi-setup-new": "hash" }; f.save(); f.put("agents/ops.md.pi-setup-new", "new");
  assert.equal(f.checks().find(c => c.id === "pending")?.status, "warn");
  unlinkSync(f.file);
  assert.equal(f.checks().find(c => c.id === "files")?.fixable, "restore");
  f.facts.head = "moved";
  assert.match(f.checks().find(c => c.id === "files")!.detail, /checkout moved/);
});

for (const scenario of ["clean", "dirty", "unknown-status", "moved", "unknown-head", "unknown-commit"] as const) test(`missing files advertise restore only when F2 can run: ${scenario}`, () => {
  const f = fixture(); unlinkSync(f.file);
  if (scenario === "dirty") f.facts.checkoutClean = false;
  if (scenario === "unknown-status") f.facts.checkoutClean = undefined;
  if (scenario === "moved") f.facts.head = "moved";
  if (scenario === "unknown-head") f.facts.head = undefined;
  if (scenario === "unknown-commit") { delete f.manifest.source.commit; f.save(); }
  const files = f.checks().find(c => c.id === "files")!;
  assert.equal(files.fixable, scenario === "clean" ? "restore" : undefined);
  assert.equal(files.fix, scenario === "dirty" ? "commit or stash local changes, then rerun" : "pi-setup");
});

test("doctor git reads disable optional locks, including release probes", async () => {
  const f = fixture();
  delete f.manifest.source.release; f.save();
  unlinkSync(join(f.pi, ".pi-setup/update-check.json"));
  await main(["doctor", "--json"], f.ctx);
  const gitArgs = f.calls.filter(c => c.cmd === "git").map(c => c.args);
  for (const args of [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain"],
    ["ls-remote", "--tags", "--refs", "origin", "v*"],
    ["describe", "--tags", "--abbrev=0"],
  ]) assert.ok(gitArgs.some(actual => JSON.stringify(actual) === JSON.stringify(["--no-optional-locks", "-C", f.ctx.repoDir, ...args])));
  assert.ok(gitArgs.every(args => args[0] === "--no-optional-locks"));
});

test("missing install, missing and invalid manifest", () => {
  const f = fixture();
  const ctx = testCtx(sandbox().home);
  assert.equal(localChecks(ctx, f.facts).checks[0].status, "fail");
  unlinkSync(join(f.pi, ".pi-setup/manifest.json"));
  assert.equal(f.checks()[0].status, "warn");
  f.put(".pi-setup/manifest.json", "broken");
  assert.equal(f.checks()[0].status, "fail");
});

test("npm dependencies, scoped settings packages and local paths", () => {
  const f = fixture();
  unlinkSync(join(f.pi, "npm/node_modules/example/package.json"));
  assert.equal(f.checks().find(c => c.id === "npm")?.fixable, "npm");
  f.put("settings.json", '{"packages":["npm:@scope/pkg@2","./absent"]}');
  assert.equal(f.checks().filter(c => c.id.startsWith("package:")).length, 2);
});

test("profile requirements, catalog and fallback readiness", () => {
  const f = fixture();
  f.facts.providers["kimi-coding"] = { status: "not_ready" };
  assert.equal(f.checks().find(c => c.id.startsWith("fallback:"))?.status, "warn");
  f.put("provider-fallback.json", '{"enabled":false}');
  assert.equal(f.checks().find(c => c.id.startsWith("fallback:"))?.status, "fail");
  f.facts.providers.anthropic = { status: "not_ready" };
  assert.equal(f.checks().find(c => c.id === "profile")?.status, "fail");
  f.facts.providers.anthropic = { status: "unknown" };
  assert.equal(f.checks().find(c => c.id === "profile")?.status, "warn");
  f.facts.providers.anthropic = { status: "ready" }; f.facts.catalog = new Set();
  assert.equal(f.checks().find(c => c.id === "models")?.status, "fail");
  f.facts.summary = true;
  assert.equal(f.checks().find(c => c.id === "models")?.status, "skip");
});

for (const scenario of ["timeout", "error", "unparsable", "rejected"] as const) test(`unknown provider gets its own warning without a fallback risk: ${scenario}`, async () => {
  const f = fixture();
  f.facts.providers.anthropic = { status: "not_ready" };
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => {
    if (cmd !== "pi" || args[0] !== "auth" || args[3] !== "kimi-coding") return run(cmd, args, opts);
    if (scenario === "rejected") throw new Error("auth check failed");
    return { code: scenario === "error" ? 1 : 0, stdout: scenario === "unparsable" ? "not JSON" : "", stderr: "", timedOut: scenario === "timeout" };
  };
  await main(["doctor"], f.ctx);
  assert.ok(f.out.some(line => /^⚠ provider:kimi-coding: Kimi: could not determine$/.test(line)));
  assert.ok(f.out.some(line => /^✖ profile:.*Claude has no login/.test(line)));
  assert.ok(!f.out.some(line => /fallback:kimi-coding|Kimi has no login/.test(line)));
});

test("unknown or absent pinned providers do not produce a fallback risk", () => {
  const f = fixture();
  f.facts.providers["kimi-coding"] = { status: "unknown" };
  assert.equal(f.checks().find(c => c.id === "provider:kimi-coding")?.status, "warn");
  assert.ok(!f.checks().some(c => c.id.startsWith("fallback:")));
  delete f.facts.providers["kimi-coding"];
  assert.ok(!f.checks().some(c => c.id.startsWith("fallback:")));
});

test("guards and PATH user choices", () => {
  const f = fixture();
  f.put("guards.json", '{"off":{"mcp":true}}');
  assert.equal(f.checks().find(c => c.id === "guards")?.status, "ok");
  f.put("guards.json", '{"off":[]}');
  assert.equal(f.checks().find(c => c.id === "guards")?.status, "warn");
  f.ctx.env.PATH = "/bin"; f.ctx.env.SHELL = "/bin/zsh";
  assert.match(f.checks().find(c => c.id === "path")!.fix!, /zshrc/);
});

test("summary reuses detection and never runs a command", async () => {
  const f = fixture();
  const lines = await installSummary(f.ctx, { providers: f.facts.providers, catalog: f.facts.catalog, github: { orgs: [] } } as Parameters<typeof installSummary>[1], f.pi);
  assert.match(lines[0], /^Doctor: all/);
  assert.equal(f.calls.length, 0);
});

test("F1 and F3 repair only npm and unchanged file modes, then recheck", async () => {
  const f = fixture();
  unlinkSync(join(f.pi, "npm/node_modules/example/package.json")); chmodSync(f.file, 0o755);
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => { if (cmd === "npm") { assert.equal(opts?.cwd, join(f.pi, "npm")); f.put("npm/node_modules/example/package.json", "{}"); } return run(cmd, args, opts); };
  assert.equal(await main(["doctor", "--fix", "--json"], f.ctx), 0);
  assert.equal(statSync(f.file).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(f.out[0]).fixed, ["npm", "chmod"]);
});

for (const scenario of ["dirty", "untracked", "timeout", "error"] as const) test(`F2 refuses an unsafe checkout: ${scenario}`, async () => {
  const f = fixture(); unlinkSync(f.file);
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => {
    const r = await run(cmd, args, opts);
    if (cmd !== "git" || !args.includes("status")) return r;
    assert.deepEqual(args, ["--no-optional-locks", "-C", f.ctx.repoDir, "status", "--porcelain"]);
    return { ...r, stdout: scenario === "dirty" ? " M installer/src/doctor.ts\n" : scenario === "untracked" ? "?? local.txt\n" : "", code: scenario === "error" ? 1 : 0, timedOut: scenario === "timeout" };
  };
  assert.equal(await main(["doctor", "--fix"], f.ctx), 2);
  assert.ok(!f.calls.some(c => c.args.includes("--skip-npm")));
  assert.ok(!existsSync(f.file));
  if (scenario === "dirty" || scenario === "untracked") assert.ok(f.out.includes("  fix: commit or stash local changes, then rerun"));
});

test("F2 restores only in a clean checkout at the installed commit", async () => {
  const f = fixture(); unlinkSync(f.file);
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => { if (args.includes("--skip-npm")) { assert.equal(cmd, process.execPath); f.put("agents/ops.md", "---\nmodel: kimi-coding/k3-256k\nextensions: provider-fallback\n---\n"); chmodSync(f.file, 0o644); } return run(cmd, args, opts); };
  assert.equal(await main(["doctor", "--fix"], f.ctx), 0);
  assert.ok(existsSync(f.file));
  assert.ok(f.calls.some(c => c.cmd === "git" && c.args.includes("status")));
  assert.ok(f.calls.some(c => c.args.includes("--skip-npm")));
  unlinkSync(f.file); f.manifest.source.commit = "old"; f.save(); f.calls.length = 0;
  assert.equal(await main(["doctor", "--fix"], f.ctx), 2);
  assert.ok(!f.calls.some(c => c.args.includes("--skip-npm")));
});

for (const scenario of ["offline", "fresh", "stale", "failed", "no-dir"] as const) test(`update cache: ${scenario}`, async () => {
  const f = fixture();
  if (scenario !== "fresh") unlinkSync(join(f.pi, ".pi-setup/update-check.json"));
  if (scenario === "offline") f.ctx.env.PI_OFFLINE = "1";
  if (scenario === "no-dir") { const { rmSync } = await import("node:fs"); rmSync(join(f.pi, ".pi-setup"), { recursive: true }); }
  if (scenario === "failed") { const run = f.ctx.run; f.ctx.run = async (c, a, o) => a.includes("ls-remote") ? { code: 1, stdout: "", stderr: "offline", timedOut: false } : run(c, a, o); }
  await main(["doctor", "--json"], f.ctx);
  const remote = f.calls.find(c => c.args.includes("ls-remote"));
  assert.equal(Boolean(remote), scenario === "stale" || scenario === "no-dir");
  if (remote) assert.equal(remote.options?.timeoutMs, 5000);
  assert.equal(existsSync(join(f.pi, ".pi-setup/update-check.json")), scenario === "fresh" || scenario === "stale");
});

test("probe failures, disk mapping and launchd/docker gating", async () => {
  const f = fixture();
  await main(["doctor", "--json"], f.ctx);
  assert.ok(!f.calls.some(c => c.cmd === "launchctl" || c.cmd === "docker"));
  const dir = join(f.box.home, "Library/LaunchAgents"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "guardian.plist"), "<key>Label</key><string>test.docker-guardian</string>");
  f.ctx.platform = "darwin"; f.out.length = 0;
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => {
    if (cmd === "launchctl" || cmd === "docker") { f.calls.push({ cmd, args, options: opts }); return { code: 1, stdout: "", stderr: "no", timedOut: false }; }
    if (cmd === "python3") return { code: 0, stdout: JSON.stringify([{ id: "disk", severity: "high", evidence: "low", suggest: "clean" }]), stderr: "", timedOut: false };
    return run(cmd, args, opts);
  };
  assert.equal(await main(["doctor", "--json"], f.ctx), 2);
  const checks = JSON.parse(f.out[0]).checks;
  assert.equal(checks.find((c: {id: string}) => c.id === "docker").status, "warn");
  assert.equal(checks.find((c: {id: string}) => c.id === "disk").status, "fail");
});

test("doctor argument errors exit 2; other commands keep exit 1", async () => {
  const f = fixture();
  assert.equal(await main(["install", "doctor", "--yes"], f.ctx), 2);
  assert.equal(await main(["--fix"], f.ctx), 1);
});

for (const scenario of ["pi-missing", "pi-timeout", "pi-crash", "gh-missing", "gh-logged-out", "empty-models", "auth-timeout", "disk-missing", "disk-timeout", "disk-invalid", "disk-skipped"] as const) test(`probes: ${scenario}`, async () => {
  const f = fixture();
  const run = f.ctx.run;
  f.ctx.which = name => (scenario === "pi-missing" && name === "pi") || (scenario === "gh-missing" && name === "gh") ? undefined : "/stub";
  if (scenario === "disk-missing") unlinkSync(join(f.pi, "bin/dev-doctor"));
  f.ctx.run = async (cmd, args, opts) => {
    const r = await run(cmd, args, opts);
    if (cmd === "pi" && scenario === "pi-timeout") return { ...r, code: null, timedOut: true };
    if (cmd === "pi" && args[0] === "auth" && scenario === "auth-timeout") return { ...r, code: null, timedOut: true };
    if (cmd === "pi" && args.includes("--list-models") && scenario === "pi-crash") return { ...r, code: 1, stderr: "Extension crash\nmore" };
    if (cmd === "pi" && args.includes("--list-models") && scenario === "empty-models") return { ...r, stdout: "No models available" };
    if (cmd === "gh" && scenario === "gh-logged-out") return { ...r, code: 1, stdout: "" };
    if (cmd === "python3" && scenario === "disk-timeout") return { ...r, timedOut: true };
    if (cmd === "python3" && scenario === "disk-invalid") return { ...r, stdout: "not JSON" };
    if (cmd === "python3" && scenario === "disk-skipped") return { ...r, stdout: '[{"id":"disk","severity":"info","evidence":"Skipped: no disk"}]' };
    return r;
  };
  await main(["doctor", "--json"], f.ctx);
  const checks = JSON.parse(f.out[0]).checks;
  const get = (id: string) => checks.find((c: {id: string}) => c.id === id);
  if (scenario === "pi-missing") { assert.equal(get("pi").status, "fail"); assert.ok(!f.calls.some(c => c.cmd === "pi")); }
  if (scenario === "pi-timeout") assert.equal(get("pi").status, "warn");
  if (scenario === "pi-crash") { assert.equal(get("pi").status, "fail"); assert.match(get("pi").detail, /Extension crash/); }
  if (scenario.startsWith("gh-")) assert.equal(get("gh").status, "warn");
  if (scenario === "empty-models") assert.equal(get("models").status, "fail");
  if (scenario === "auth-timeout") assert.match(get("profile").detail, /could not check/);
  if (scenario.startsWith("disk-")) assert.equal(get("disk").status, "warn");
});

test("fallback chains and reverse pairs require a loaded extension on every agent", () => {
  const f = fixture(); f.facts.providers["kimi-coding"] = { status: "not_ready" };
  f.put("provider-fallback.json", '{"enabled":true,"chains":{"kimi-coding/k3-256k":["absent/a","openai-codex/gpt-6.1-sol"]}}');
  assert.equal(f.checks().find(c => c.id.startsWith("fallback:"))?.status, "warn");
  f.put("agents/scout.md", "---\nmodel: kimi-coding/k3-256k\n---\n");
  assert.equal(f.checks().find(c => c.id.startsWith("fallback:"))?.status, "fail");
  unlinkSync(join(f.pi, "agents/scout.md"));
  f.put("provider-fallback.json", '{"enabled":true,"pairs":[["openai-codex/gpt-6.1-sol","kimi-coding/k3-256k"]]}');
  assert.equal(f.checks().find(c => c.id.startsWith("fallback:"))?.status, "warn");
  f.facts.catalog!.delete("openai-codex/gpt-6.1-sol");
  assert.equal(f.checks().find(c => c.id.startsWith("fallback:"))?.status, "fail");
});

test("an optional provider does not fail the profile and summary skips an empty catalog", async () => {
  const f = fixture(); f.facts.providers["kimi-coding"] = { status: "not_ready" };
  assert.equal(f.checks().find(c => c.id === "profile")?.status, "ok");
  f.facts.summary = true; f.facts.catalog = null;
  assert.equal(f.checks().find(c => c.id === "models")?.status, "skip");
  unlinkSync(join(f.pi, "profiles/ACTIVE"));
  assert.equal(f.checks().find(c => c.id === "profile")?.status, "warn");
  f.put("profiles/ACTIVE", "custom");
  assert.match(f.checks().find(c => c.id === "profile")!.detail, /unknown profile/);
});

test("guard env, malformed shapes and shell-specific PATH suggestions are read-only", () => {
  const f = fixture(); f.ctx.env.PI_GUARDS_OFF = "mcp";
  assert.match(f.checks().find(c => c.id === "guards")!.detail, /PI_GUARDS_OFF=mcp/);
  for (const invalid of ["broken", '{"off":{ "mcp":"yes"}}', "[]"]) {
    f.put("guards.json", invalid);
    assert.equal(f.checks().find(c => c.id === "guards")?.status, "warn");
  }
  f.ctx.env.PATH = "/bin";
  for (const [shell, rc] of [["/bin/bash", ".bashrc"], ["/bin/fish", ".config/fish/config.fish"]]) {
    f.ctx.env.SHELL = shell;
    const fix = f.checks().find(c => c.id === "path")!.fix!;
    assert.ok(fix.startsWith("echo '") && fix.endsWith(` >> ~/${rc}`), fix);
  }
});

test("JSON fixes keep stdout to one object and do not chmod edited files", async () => {
  const f = fixture(); writeFileSync(f.file, "my edits"); chmodSync(f.file, 0o755);
  f.put("guards.json", '{"off":{"mcp":true}}');
  const before = snapshot(f.box.home);
  await main(["doctor", "--fix", "--json"], f.ctx);
  assert.equal(f.out.length, 1); assert.deepEqual(JSON.parse(f.out[0]).fixed, []);
  assert.deepEqual(snapshot(f.box.home), before);
});

test("pending entry and symlink mismatch use home-relative manifest paths", async () => {
  const f = fixture();
  const { symlinkSync } = await import("node:fs");
  const rel = ".pi/agent/link";
  f.manifest.symlinks[rel] = { target: ".pi/agent/agents/ops.md", origin: "new" };
  f.save();
  assert.equal(f.checks().find(c => c.id === "files")?.status, "fail");
  symlinkSync("agents/ops.md", join(f.pi, "link"));
  assert.equal(f.checks().find(c => c.id === "files")?.status, "ok");
  unlinkSync(join(f.pi, "link")); symlinkSync("guards.json", join(f.pi, "link"));
  assert.equal(f.checks().find(c => c.id === "files")?.status, "fail");
  f.manifest.files[".pi/agent/agents/ops.md"].pending = { path: ".pi/agent/agents/ops.md.pi-setup-new", sha256: "hash" }; f.save();
  f.put("agents/ops.md.pi-setup-new", "new");
  assert.equal(f.checks().find(c => c.id === "pending")?.status, "warn");
});

test("optional command suggestions prefer links only when the package script exists", () => {
  const f = fixture();
  f.put("settings.json", '{"packages":["npm:@woksin/pi-context-budget","npm:@woksin/pi-orch"]}');
  f.ctx.which = () => undefined;
  assert.match(f.checks().find(c => c.id === "path:orch")!.fix!, /https:/);
  f.put("npm/node_modules/@woksin/pi-orch/bin/orch", "script");
  assert.match(f.checks().find(c => c.id === "path:orch")!.fix!, /^ln -s/);
});

test("path:<cmd> says installed-but-not-on-PATH when the link exists, missing only when absent", () => {
  const f = fixture();
  f.put("settings.json", '{"packages":["npm:@woksin/pi-orch"]}');
  f.ctx.which = () => undefined;
  f.ctx.env = { ...f.ctx.env, PATH: "/usr/bin" };
  const none = f.checks().find(c => c.id === "path:orch")!;
  assert.equal(none.status, "warn"); assert.match(none.detail, /is missing/);
  mkdirSync(join(f.ctx.home, ".local/bin"), { recursive: true });
  symlinkSync("/nowhere", join(f.ctx.home, ".local/bin/orch"));
  const c = f.checks().find(c => c.id === "path:orch")!;
  assert.equal(c.status, "warn");
  assert.match(c.detail, /installed at ~\/\.local\/bin\/orch, but ~\/\.local\/bin is not on PATH/);
  assert.match(c.fix!, /--edit-shell-profile/);
});

test("F3 revalidates content after npm rather than changing a newly edited file", async () => {
  const f = fixture(); chmodSync(f.file, 0o755); unlinkSync(join(f.pi, "npm/node_modules/example/package.json"));
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => { if (cmd === "npm") writeFileSync(f.file, "edited while fixing"); return run(cmd, args, opts); };
  await main(["doctor", "--fix", "--json"], f.ctx);
  assert.equal(statSync(f.file).mode & 0o777, 0o755);
  assert.ok(!JSON.parse(f.out[0]).fixed.includes("chmod"));
});
