import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "../src/run.ts";
import { PINNED_PACKAGES, PACKAGE_BINS, npmSpec, pinPackages } from "../src/packages.ts";
import { emptyManifest, manifestPath } from "../src/manifest.ts";
import { undo } from "../src/uninstall.ts";
import { localChecks } from "../src/doctor-checks.ts";
import { configureShellPath, shellPath } from "../src/shell-path.ts";
import { REPO, sandbox, testCtx } from "./helpers/home.ts";

const args = ["--yes", "--user", "tester", "--repos-root", "/tmp/none"];
const put = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

test("fresh install pins and fetches all four packages and links all shipped CLIs on its first run", async () => {
  const { home } = sandbox();
  const pi = join(home, ".pi/agent");
  const calls: string[][] = [];
  const ctx = testCtx(home, { which: () => "/stub", run: async (cmd, argv) => {
    if (cmd === "npm" && argv[0] === "install") {
      calls.push(argv);
      for (const p of PINNED_PACKAGES) put(join(pi, "npm/node_modules", p.name, "package.json"), JSON.stringify({ version: p.version }));
      for (const [pkg, cmd] of PACKAGE_BINS) put(join(pi, "npm/node_modules/@woksin", pkg, "bin", cmd), "#!/bin/sh\n");
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  } });
  assert.equal(await main(args, ctx), 0);
  assert.deepEqual(calls[0], ["install", ...PINNED_PACKAGES.map(npmSpec), "--save-exact", "--legacy-peer-deps", "--no-audit", "--no-fund", "--loglevel=error"]);
  const settings = JSON.parse(readFileSync(join(pi, "settings.json"), "utf8"));
  for (const p of PINNED_PACKAGES) assert.ok(settings.packages.includes(`npm:${npmSpec(p)}`));
  for (const [pkg, cmd] of [["pi-context-budget", "pi-session"], ["pi-orch", "orch"], ["pi-orch", "orch-poll"]]) assert.equal(readlinkSync(join(home, ".local/bin", cmd)), join(pi, "npm/node_modules/@woksin", pkg, "bin", cmd));
});

test("removing a recorded pin then rerunning leaves it removed", async () => {
  const { home } = sandbox();
  const path = join(home, ".pi/agent/settings.json");
  const ctx = testCtx(home, { which: () => "/stub" });
  assert.equal(await main([...args, "--skip-npm"], ctx), 0);
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.packages = data.packages.filter((p: string) => p !== "npm:@woksin/pi-orch@0.1.1");
  put(path, JSON.stringify(data));
  assert.equal(await main([...args, "--skip-npm"], ctx), 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), data);
});

for (const op of [
  { op: "array-add" as const, key: "packages", value: "npm:@woksin/pi-orch@0.1.0", keyCreated: false },
  { op: "array-replace" as const, key: "packages", before: "npm:@woksin/pi-orch", after: "npm:@woksin/pi-orch@0.1.0" },
]) test(`earlier ${op.op} keeps removals and upgrades only a still-present managed pin`, () => {
  const { home } = sandbox();
  const pi = join(home, ".pi/agent");
  const manifest = emptyManifest(new Date());
  manifest.json[".pi/agent/settings.json"] = { created: false, sha256After: "", ops: [op] };
  put(manifestPath(pi), JSON.stringify(manifest));
  const removed = { packages: ["npm:user-choice@1"] };
  pinPackages(removed, pi);
  assert.ok(!removed.packages.some(p => p.includes("pi-orch")));
  assert.ok(removed.packages.includes("npm:@woksin/pi-jobs@0.3.1"), "new packages are still adopted");
  const present = { packages: ["npm:user-choice@1", "npm:@woksin/pi-orch@0.1.0", "npm:other@2"] };
  const ops = pinPackages(present, pi);
  assert.equal(present.packages[1], "npm:@woksin/pi-orch@0.1.1");
  assert.deepEqual(ops.find(o => o.op === "array-replace"), { op: "array-replace", key: "packages", before: "npm:@woksin/pi-orch@0.1.0", after: "npm:@woksin/pi-orch@0.1.1" });
});

for (const code of [0, 1]) test(`npm exit ${code} preserves unrelated manifest entries and saves only successful selected pins`, async () => {
  const { home } = sandbox();
  const path = join(home, ".pi/agent/npm/package.json");
  const original = { name: "user-store", private: true, scripts: { check: "keep" }, dependencies: { unrelated: "^1.2.3" }, optionalDependencies: { optional: "~2.0.0" } };
  const before = JSON.stringify(original);
  put(path, before);
  const ctx = testCtx(home, { which: () => "/stub", run: async (cmd, argv) => {
    if (cmd === "npm" && argv[0] === "install") {
      put(path, JSON.stringify({ ...original, scripts: {}, dependencies: { unrelated: "1.9.0" }, extra: "npm normalization" }));
      return { code, stdout: "", stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  } });
  assert.equal(await main(args, ctx), code);
  if (code === 1) assert.equal(readFileSync(path, "utf8"), before);
  else assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...original, dependencies: { ...original.dependencies, ...Object.fromEntries(PINNED_PACKAGES.map(p => [p.name, p.version])) } });
});

for (const code of [0, 1]) test(`invalid npm manifests reach npm and remain untouched by preservation (exit ${code})`, async () => {
  const { home } = sandbox();
  const path = join(home, ".pi/agent/npm/package.json");
  const before = '{"name":"user-store"}\n// user edit\n';
  put(path, before);
  utimesSync(path, 1, 1);
  const modified = statSync(path).mtimeMs;
  let calls = 0;
  const ctx = testCtx(home, { which: () => "/stub", run: async (cmd, argv) => {
    if (cmd === "npm" && argv[0] === "install") {
      calls++;
      assert.equal(readFileSync(path, "utf8"), before);
      return { code, stdout: "", stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  } });
  assert.equal(await main(args, ctx), code);
  assert.equal(calls, 1);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(statSync(path).mtimeMs, modified);
});

for (const skip of [true, false]) test(`absent package CLI targets do not produce dangling launchers (skip npm: ${skip})`, async () => {
  const { home } = sandbox();
  assert.equal(await main([...args, ...(skip ? ["--skip-npm"] : [])], testCtx(home, { which: () => "/stub" })), 0);
  for (const [, cmd] of PACKAGE_BINS) assert.throws(() => readlinkSync(join(home, ".local/bin", cmd)), { code: "ENOENT" });
});

test("doctor reports exact version drift, both PATH entries, prerequisites and orch-poll", async () => {
  const { home } = sandbox();
  const pi = join(home, ".pi/agent");
  put(join(pi, "settings.json"), JSON.stringify({ packages: PINNED_PACKAGES.map(p => `npm:${npmSpec(p)}`) }));
  put(join(pi, "npm/node_modules/@woksin/pi-jobs/package.json"), '{"version":"0.1.0"}');
  const ctx = testCtx(home, { which: () => undefined, env: { PATH: "", SHELL: "/bin/zsh" } });
  const checks = localChecks(ctx, { providers: {}, catalog: null, summary: true }).checks;
  for (const p of PINNED_PACKAGES) assert.equal(checks.find(c => c.id === `package:${p.name}`)?.status, "fail");
  assert.match(checks.find(c => c.id === "package:@woksin/pi-jobs")!.detail, /installed 0.1.0, expected 0.3.1/);
  assert.match(checks.find(c => c.id === "path")!.detail, /~\/.local\/bin, ~\/.pi\/agent\/bin/);
  assert.equal(checks.find(c => c.id === "path:orch-poll")?.status, "warn");
  for (const tool of ["gh", "jq", "rg", "fd"]) {
    assert.equal(checks.find(c => c.id === `tool:${tool}`)?.status, "fail");
    assert.ok(checks.find(c => c.id === `tool:${tool}`)?.fix);
  }
  ["gitleaks", "rtk", "docker", "tmux"].forEach(tool => assert.equal(checks.find(c => c.id === `tool:${tool}`)?.status, "warn"));
});

for (const shell of ["bash", "zsh", "fish"]) test(`shell PATH changes require opt-in, are shell-aware and idempotent (${shell})`, () => {
  const { home } = sandbox();
  const ctx = testCtx(home, { env: { SHELL: `/bin/${shell}`, PATH: "" } });
  const { file, snippet } = shellPath(ctx);
  put(file, "# keep me\n");
  configureShellPath(ctx, false, false);
  configureShellPath(ctx, true, true);
  assert.equal(readFileSync(file, "utf8"), "# keep me\n");
  configureShellPath(ctx, true, false);
  configureShellPath(ctx, true, false);
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith("# keep me\n"));
  assert.equal(text.split(snippet).length, 2);
  assert.match(snippet, shell === "fish" ? /^fish_add_path/ : /^export PATH=/);
});

for (const explicit of [false, true]) test(`sandbox launchd guard protects install, turn-off, uninstall (explicit=${explicit})`, async () => {
  const { home } = sandbox();
  const calls: string[] = [];
  const out: string[] = [];
  const ctx = testCtx(home, { platform: "darwin", userHome: explicit ? home : "/real-user", which: () => "/stub", out: l => out.push(l), run: async (cmd, argv) => {
    if (cmd === "launchctl") calls.push(argv.join(" "));
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  } });
  const flags = explicit ? ["--no-launchd"] : [];
  const install = [...args, "--skip-npm", ...flags];
  assert.equal(await main([...install, "--with", "docker-guardian"], ctx), 0);
  assert.equal(await main([...install, "--without", "docker-guardian"], ctx), 0);
  assert.equal(await main([...install, "--with", "docker-guardian"], ctx), 0);
  assert.equal(await main(["uninstall", "--yes", ...flags], ctx), 0);
  assert.deepEqual(calls, []);
  assert.ok(out.some(l => l.includes("skipping launchd load/unload")));
});

test("package registrations undo individually and preserve concurrent user selections", () => {
  const data = { packages: ["npm:@woksin/pi-jobs", "npm:unrelated@1"] };
  const original = [...data.packages];
  const ops = pinPackages(data, "/unused");
  assert.deepEqual(pinPackages(data, "/unused"), []);
  data.packages.push("npm:user-added@2");
  for (const op of ops.reverse()) assert.equal(undo(data, op), true);
  assert.deepEqual(data.packages, [...original, "npm:user-added@2"]);
});

test("install, web retirement, rerun and uninstall preserve edited settings and restore floating sources", async () => {
  const { home } = sandbox();
  const path = join(home, ".pi/agent/settings.json");
  const initial = ["npm:@woksin/pi-jobs", "npm:user-owned@1"];
  put(path, JSON.stringify({ packages: initial, custom: true }));
  const ctx = testCtx(home, { which: () => "/stub" });
  assert.equal(await main([...args, "--skip-npm", "--with", "web"], ctx), 0);
  const data = JSON.parse(readFileSync(path, "utf8"));
  data.packages.push("npm:user-added@2");
  put(path, JSON.stringify(data));
  assert.equal(await main([...args, "--skip-npm", "--without", "web"], ctx), 0);
  assert.equal(await main(["uninstall", "--yes"], ctx), 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { packages: [...initial, "npm:user-added@2"], custom: true });
});

test("explicit npm versions, filtered package objects and arbitrarily named local overrides stay selected", async () => {
  const { home } = sandbox();
  const pi = join(home, ".pi/agent");
  const packages = ["npm:@woksin/pi-jobs@9.9.9", "./custom-recovery", { source: "npm:@woksin/pi-context-budget@8.0.0", extensions: [] }, "./local-packages/pi-orch"];
  put(join(pi, "custom-recovery/package.json"), JSON.stringify({ name: "@woksin/pi-recover" }));
  put(join(pi, "settings.json"), JSON.stringify({ packages }));
  const calls: string[][] = [];
  const ctx = testCtx(home, { which: () => "/stub", run: async (cmd, argv) => {
    if (cmd === "npm" && argv[0] === "install") calls.push(argv);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  } });
  assert.equal(await main([...args, "--without", "web"], ctx), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(pi, "settings.json"), "utf8")).packages, [...packages, "./local-packages/pi-questions"]);
  assert.deepEqual(calls, [["install", "--save-exact", "--legacy-peer-deps", "--no-audit", "--no-fund", "--loglevel=error"]]);
});

test("foreign launcher files and links survive installation", async () => {
  const { home } = sandbox();
  put(join(home, ".local/bin/orch"), "user command\n");
  put(join(home, "custom-poll"), "user poller\n");
  symlinkSync(join(home, "custom-poll"), join(home, ".local/bin/orch-poll"));
  assert.equal(await main([...args, "--skip-npm"], testCtx(home, { which: () => "/stub" })), 0);
  assert.equal(readFileSync(join(home, ".local/bin/orch"), "utf8"), "user command\n");
  assert.equal(readlinkSync(join(home, ".local/bin/orch-poll")), join(home, "custom-poll"));
  assert.ok(readFileSync(join(home, ".pi/agent/local-packages/pi-questions/package.json"), "utf8").includes("pi-questions"));
});

test("shell shim accepts supported and future Node majors and rejects old runtimes", () => {
  const { home } = sandbox();
  const bin = join(home, "shim");
  const node = join(bin, "node");
  put(node, `#!/bin/sh
if [ "$1" = "-e" ]; then
  exec "$REAL_NODE" -e 'Object.defineProperty(process.versions,"node",{value:process.env.TEST_NODE_VERSION});eval(process.argv[1])' "$2"
fi
if [ "$1" = "-p" ]; then echo "$TEST_NODE_VERSION"; fi
exit 0
`);
  chmodSync(node, 0o755);
  for (const version of ["22.19.0", "24.1.0", "26.8.0", "30.0.0", "22.18.0", "20.19.0"]) {
    const supported = !["22.18.0", "20.19.0"].includes(version);
    const result = spawnSync("/bin/bash", [join(REPO, "install.sh"), ...(supported ? ["--help"] : ["--no-install-prereqs"])], { encoding: "utf8", env: { HOME: home, PI_SETUP_SYSTEM_BIN_DIRS: join(home, "no-system-bin"), PATH: `${bin}:/usr/bin:/bin`, REAL_NODE: process.execPath, TEST_NODE_VERSION: version } });
    assert.equal(result.status, supported ? 0 : 1, version);
    assert.equal(result.stderr.includes("needs Node.js"), !supported, version);
  }
});
