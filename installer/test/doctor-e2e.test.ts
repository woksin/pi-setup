import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { install, piPath, REPO, sandbox, snapshot } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach(b => rmSync(b.root, { recursive: true, force: true })));
function ready(cleanCheckout = false) {
  const box = sandbox(); boxes.push(box);
  let repo: string | undefined;
  if (cleanCheckout) {
    repo = join(box.root, "checkout"); mkdirSync(repo);
    for (const path of ["agent", "skills", "tools", "install.sh", "installer/dist"]) cpSync(join(REPO, path), join(repo, path), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo!, ...args], { env: { ...process.env, HOME: box.home } });
    git("init", "--quiet"); git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  }
  mkdirSync(join(box.root, "repos"));
  const run = install(box, ["--yes", "--skip-npm", "--without", "codescene", "--user", "tester", "--repos-root", join(box.root, "repos")], { repo, entry: repo ? "node" : "shim" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  writeFileSync(piPath(box, "dev-doctor.json"), '{"disk":{"build_floor_gib":0,"cleanup_trigger_gib":0}}');
  const bin = join(box.home, ".local/bin"); mkdirSync(bin, { recursive: true });
  for (const cmd of ["pi-session", "orch"]) { const p = join(bin, cmd); writeFileSync(p, "#!/bin/sh\nexit 0\n"); chmodSync(p, 0o755); }
  const settings = JSON.parse(readFileSync(piPath(box, "settings.json"), "utf8"));
  const deps = Object.keys(JSON.parse(readFileSync(piPath(box, "npm/package.json"), "utf8")).dependencies);
  for (const pkg of settings.packages.filter((p: string) => p.startsWith("npm:"))) { const full = pkg.slice(4); const at = full.indexOf("@", 1); deps.push(at < 0 ? full : full.slice(0, at)); }
  for (const dep of deps) { const d = piPath(box, "npm/node_modules", dep); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "package.json"), "{}"); }
  const pins = new Set<string>([`${settings.defaultProvider}/${settings.defaultModel}`]);
  for (const file of readdirSync(piPath(box, "agents"))) { const pin = /^model:\s*(\S+)/m.exec(readFileSync(piPath(box, "agents", file), "utf8"))?.[1]; if (pin) pins.add(pin); }
  const fallback = JSON.parse(readFileSync(piPath(box, "provider-fallback.json"), "utf8"));
  for (const pair of fallback.pairs) for (const model of pair) pins.add(model);
  for (const targets of Object.values(fallback.chains) as string[][]) for (const model of targets) pins.add(model);
  const options = { repo, entry: repo ? "node" as const : "shim" as const, path: [box.stubs, bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), env: { PI_OFFLINE: "1", STUB_MODELS: [...pins].map(p => p.replace("/", " ")).join("\n") } };
  return { box, options };
}

test("green doctor via shim and node: under 10 seconds, JSON and read-only HOME", t => {
  const { box, options } = ready();
  const before = snapshot(box.home, true);
  const start = performance.now();
  const run = install(box, ["doctor"], options);
  const elapsed = performance.now() - start;
  t.diagnostic(`green doctor wall time: ${elapsed.toFixed(0)} ms`);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(elapsed < 10000, `${elapsed} ms`);
  assert.match(run.stdout, /✔/);
  assert.deepEqual(snapshot(box.home, true), before);
  const json = install(box, ["doctor", "--json"], { ...options, entry: "node" });
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.equal(JSON.parse(json.stdout).exitCode, 0);
  assert.deepEqual(snapshot(box.home, true), before);
});

test("no Kimi login warns honestly about ops/scout and parent-model risk", () => {
  const { box, options } = ready();
  const run = install(box, ["doctor"], { ...options, ready: "anthropic,openai-codex" });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /⚠.*ops.*scout.*kimi-coding\/k3-256k.*parent model/);
  assert.match(run.stdout, /  fix: .*\/login.*Kimi/);
});

test("missing tracked file fails; safe restore succeeds", () => {
  const { box, options } = ready(true);
  const path = piPath(box, "agents/ops.md"); unlinkSync(path);
  const run = install(box, ["doctor"], options);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  const fixed = install(box, ["doctor", "--fix"], options);
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.ok(existsSync(path));
  assert.match(fixed.stdout, /Fixed: restore/);
});
