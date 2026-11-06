import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults, loadConfig, saveConfig } from "../src/lanes/config.ts";
import { HEADINGS } from "../src/lanes/reap/context-format.ts";
import { treeDigest } from "../src/lanes/reap/tree.ts";
import { tempDir, REPO } from "./helpers/home.ts";

function handoffCli() {
  const home = realpathSync(tempDir("lanes-handoff-cli")); const root = join(home, "coord"); const bin = join(home, "bin");
  const cwd = join(home, "repos/.worktrees/l1"); const agent = join(home, "agent");
  for (const dir of [root, bin, cwd, agent, join(root, ".state/handoffs"), join(root, "messages/status")]) mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=l1");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture");
  const c = defaults(root, home, join(home, "repos")); c.terminal.backend = "print";
  c.messages.retention!.auto = false; c.launch.preapproveMcp = false;
  c.lanes = [{ id: "L1", repo: "example/alpha", branch: "l1", worktree: "l1", group: null, prompt: "prompts/L1.md", retired: true }]; saveConfig(root, c);
  const handoff = join(root, ".state/handoffs/L1.md");
  const snapshot = { head: git("rev-parse", "HEAD"), paths: [], unpushed: [], repo: "example/alpha", branch: "l1", worktree: cwd,
    digest: treeDigest({ cwd, paths: [], status: "", diff: "" }) };
  writeFileSync(handoff, HEADINGS.map(h => `## ${h}\nretained`).join("\n\n") + `\n\n## Snapshot\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`);
  writeFileSync(join(root, "messages/status/L1.status"), "closed reassigned-to=X\n");
  const executable = (name: string, text: string) => { const path = join(bin, name); writeFileSync(path, text); chmodSync(path, 0o700); };
  executable("pgrep", "#!/bin/sh\nexit 1\n");
  executable("ps", `#!/bin/sh\nprintf '%s 1 Mon Jan 01 00:00:00 2026 node\\n' "$PPID"\nif [ -f '${home}/child.pid' ]; then child=$(cat '${home}/child.pid'); if kill -0 "$child" 2>/dev/null; then printf '%s %s Mon Jan 01 00:00:00 2026 wrapper\\n' "$child" "$PPID"; fi; fi\n`);
  executable("pi-session", `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync('${home}/child.pid', String(process.pid)); const c=JSON.parse(fs.readFileSync('${root}/lanes.json')); const id=process.env.PI_ORCH_ID; const l=c.lanes.find(l=>l.id===id); fs.writeFileSync('${home}/observed', JSON.stringify({id, retired:l.retired, prompt:l.prompt, arg:process.argv[2], cwd:process.cwd()})); setTimeout(()=>process.exit(17), 200);\n`);
  // Execute before the terminal parent returns; acknowledge window creation rather than child exit.
  executable("tmux", `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const a=process.argv.slice(2); if(a[0]==='has-session') process.exit(1); const r=spawnSync('sh',['-c',a.at(-1)],{env:process.env,stdio:'inherit'}); process.exit(r.error?1:0);\n`);
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, LANES_DIR: root, PATH: `${bin}:${process.env.PATH}` };
  delete env.TMUX;
  const invoke = (...args: string[]) => spawnSync(process.execPath, [join(REPO, "installer/src/lanes/cli.ts"), "--dir", root, ...args], { env, encoding: "utf8", timeout: 15000 });
  const execute = (command: string) => spawnSync("sh", ["-c", command], { env, encoding: "utf8", timeout: 15000 });
  const preview = () => { const r = invoke("start", "NEW", "--from-handoff", "L1"); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout.trim().split("\n").at(-1)!; };
  return { root, home, handoff, cwd, c, invoke, execute, preview, git, observed: () => JSON.parse(readFileSync(join(home, "observed"), "utf8")) };
}
for (const id of ["NEW", "L1"]) test(`real CLI: ${id === "NEW" ? "start NEW" : "resume same ID"} restores once before failing child`, () => {
  const f = handoffCli(); const before = readFileSync(join(f.root, "lanes.json"), "utf8");
  const r = id === "NEW" ? f.invoke("start", id, "--from-handoff", "L1") : f.invoke("resume", id);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(readFileSync(join(f.root, "lanes.json"), "utf8"), before);
  const child = f.execute(r.stdout.trim().split("\n").at(-1)!); assert.equal(child.status, 17, child.stdout + child.stderr);
  assert.deepEqual(f.observed(), { id, retired: false, prompt: f.handoff, arg: `@${f.handoff}`, cwd: f.cwd });
  assert.equal(loadConfig(f.root).lanes.find(l => l.id === id)!.retired, false);
  assert.deepEqual(readdirSync(join(f.home, "agent/lanes-admission")), []);
});
for (const change of ["target", "prompt", "handoff", "HEAD", "cwd"]) test(`real CLI: delayed handoff refuses changed ${change}`, () => {
  const f = handoffCli(); const command = f.preview();
  if (change === "target") { f.c.lanes.push({ ...f.c.lanes[0], id: "NEW", worktree: "foreign", retired: false }); saveConfig(f.root, f.c); }
  if (change === "prompt") { f.c.lanes[0].prompt = "foreign.md"; saveConfig(f.root, f.c); }
  if (change === "cwd") { f.c.lanes[0].worktree = "foreign"; saveConfig(f.root, f.c); }
  if (change === "handoff") writeFileSync(f.handoff, readFileSync(f.handoff, "utf8").replace("retained", "changed"));
  if (change === "HEAD") f.git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "changed");
  const before = readFileSync(join(f.root, "lanes.json"), "utf8"); const child = f.execute(command);
  assert.equal(child.status, 1, child.stdout + child.stderr); assert.match(child.stderr, /changed|target lane already exists|does not match/);
  assert.equal(existsSync(join(f.home, "observed")), false); assert.equal(readFileSync(join(f.root, "lanes.json"), "utf8"), before);
});
test("real CLI: symlinked handoffs retain the existing refusal", () => {
  const f = handoffCli(); symlinkSync(f.handoff, join(f.root, ".state/handoffs/linked.md"));
  const before = readFileSync(join(f.root, "lanes.json"), "utf8");
  const r = f.invoke("start", "NEW", "--from-handoff", join(f.root, ".state/handoffs/linked.md"));
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /lane handoff must be a regular file/);
  assert.equal(readFileSync(join(f.root, "lanes.json"), "utf8"), before);
});
test("real CLI: terminal child can finish before start returns without parent overwriting restoration", () => {
  const f = handoffCli(); const r = f.invoke("start", "NEW", "--from-handoff", "L1", "--terminal", "tmux");
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(f.observed().id, "NEW");
  assert.equal(loadConfig(f.root).lanes.find(l => l.id === "NEW")!.prompt, f.handoff);
  assert.equal(loadConfig(f.root).lanes.find(l => l.id === "L1")!.retired, true);
});
