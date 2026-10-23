import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir, REPO } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { main } from "../src/lanes/main.ts";
import { defaults, laneDir, loadConfig, saveConfig, validate } from "../src/lanes/config.ts";
import { parseMessageName, sessionDirFor, validId, validNewId } from "../src/lanes/names.ts";
import { laneTarget } from "../src/lanes/sessions.ts";
import { discover } from "../src/lanes/adopt/discover.ts";
import { FileBackend } from "../src/lanes/backend.ts";

interface Process { pid: number; cwd: string; tty: string; session: string }
function fixture() {
  const home = realpathSync(tempDir("lanes-adopt")); const root = join(home, "coord"); mkdirSync(root);
  const rows: Process[] = []; const out: string[] = []; const err: string[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const ctx: LanesCtx = { home, cwd: root, env: {}, platform: "darwin", piAgentDir: join(home, "agent"),
    templatesDir: join(REPO, "installer/lanes/templates"), now: () => new Date("2026-10-23T12:00:00Z"),
    which: () => undefined, realpath: p => p, out: s => out.push(s), err: s => err.push(s),
    stdinTTY: true, readStdin: async () => "", loadModule: async () => ({}), sleep: async () => {},
    run: async (cmd, args) => { calls.push({ cmd, args }); return probe(cmd, args, rows); } };
  const put = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path; };
  const add = (id: string | undefined, tty = `ttys${String(rows.length).padStart(3, "0")}`, cwd = join(home, `outside/w${rows.length}`)) => {
    const p = { pid: 101 + rows.length, cwd, tty, session: `s${rows.length}` }; rows.push(p); mkdirSync(cwd, { recursive: true });
    const file = put(join(sessionDirFor(cwd, ctx.piAgentDir), `${p.session}.jsonl`), JSON.stringify({ type: "session", id: p.session, cwd }) + "\n");
    put(join(ctx.piAgentDir, "issue-work/sessions", `${p.session}.json`), JSON.stringify({ pid: p.pid, cwd, procStart: "start", sessionId: p.session, sessionFile: file }));
    if (id) put(join(ctx.piAgentDir, "user-questions/lanes", `${p.session}.json`), JSON.stringify({ lane: id, sessionId: p.session }));
    return p;
  };
  const inventory = (lines: string[]) => put(join(root, "inventory.md"), ["| tty | worktree | lane |", "| --- | --- | --- |", ...lines].join("\n"));
  return { home, root, rows, out, err, calls, ctx, put, add, inventory, invoke: (...args: string[]) => main(["--dir", root, ...args], ctx) };
}
const result = (stdout: string, code = 0) => ({ stdout, code, stderr: "failed", timedOut: false });
function probe(cmd: string, args: string[], rows: Process[]) {
  if (cmd === "pgrep") return result(rows.map(r => r.pid).join("\n"), rows.length ? 0 : 1);
  if (cmd === "lsof") { const p = rows.find(r => String(r.pid) === args[args.indexOf("-p") + 1]); return result(args.includes("cwd") ? `n${p?.cwd}\n` : ""); }
  if (cmd === "ps") return psProbe(args, rows);
  if (cmd === "git") return gitProbe(args);
  return result("", 1);
}
function gitProbe(args: string[]) {
  return result(args.includes("remote") ? "git@github.com:example/repo.git\n" : args.includes("--abbrev-ref") ? "work\n" : "");
}
function psProbe(args: string[], rows: Process[]) {
  if (args.includes("lstart=")) return result("start");
  if (args.includes("pgid=,tpgid=")) return result(`${args.at(-1)} ${args.at(-1)}`);
  if (args.includes("pid=,ppid=,pgid=,command=")) return result(rows.map(r => `${r.pid} 1 ${r.pid} pi`).join("\n"));
  if (args[0] === "-t") return result(`${rows.find(r => r.tty === args[1])?.pid} S+ pi`);
  if (args.includes("tty=")) return result(rows.find(r => String(r.pid) === args.at(-1))?.tty ?? "?");
  return result(rows.map(r => `${r.pid} 1 pi`).join("\n"));
}
function snapshot(root: string): unknown {
  return readdirSync(root).sort().map(name => { const path = join(root, name); const stat = statSync(path); return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(path) : readFileSync(path, "utf8")]; });
}
test("adopt discovers identities, git, orchestrator and exclusions without writes", async () => {
  const f = fixture(); f.add("L0", "ttys000", f.root); f.add("L3c"); f.add("R-CHR"); f.add("L4", "ttys004"); f.add("L7", "ttys007");
  const before = snapshot(f.home);
  assert.equal(await f.invoke("adopt", "--exclude-tty", "ttys004", "--exclude-tty", "ttys007"), 0, f.err.join("\n"));
  assert.deepEqual(snapshot(f.home), before); assert.ok(!existsSync(join(f.root, "lanes.json")));
  assert.match(f.out.join("\n"), /found=3 mapped=3 unmapped=0 conflicts=0 excluded=2/);
  assert.match(f.out.join("\n"), /"role": "repo-orch"/);
  assert.ok(f.calls.every(c => ["pgrep", "ps", "lsof", "git"].includes(c.cmd)));
  assert.ok(!f.calls.some(c => c.cmd === "git" && ["fetch", "checkout", "worktree"].some(a => c.args.includes(a))));
});
test("inventory only fills missing ids and conflicts never choose a lane", async () => {
  const f = fixture(); const mapped = f.add("L1"); const unknown = f.add(undefined);
  const inv = f.inventory([`| 000 | ${mapped.cwd} | L9 |`, `| 001 | ${unknown.cwd} | L18b |`]);
  assert.equal(await f.invoke("adopt", "--inventory", inv, "--write"), 0, f.err.join("\n"));
  assert.deepEqual(loadConfig(f.root).lanes.map(l => l.id), ["L18b"]);
  assert.match(f.out.join("\n"), /conflict: inventory and identity map disagree/);
  assert.match(f.out.join("\n"), /inventory/);
});
test("duplicate ids, shared cwd, unsupported ids, unmapped and exclusions are reported", async () => {
  const f = fixture(); f.add("L1"); const p = f.add("L1"); f.add("L2", "ttys002", p.cwd); f.add("L21-917"); f.add(undefined); f.add("L8", "ttys008");
  assert.equal(await f.invoke("adopt", "--exclude-tty", "ttys008", "--write"), 0, f.err.join("\n"));
  const text = f.out.join("\n");
  for (const warning of ["duplicate id", "two lanes in one cwd", "unsupported id, rename the lane", "unmapped", "excluded"]) assert.ok(text.includes(warning), warning);
  assert.deepEqual(loadConfig(f.root).lanes, []);
});
test("write merges, preserves missing entries and custom metadata and reruns are no-op", async () => {
  const f = fixture(); const p = f.add("L3c"); f.add("L0", "ttys009", f.root);
  const c = defaults(f.root, f.home); c.lanes = [{ id: "L9", repo: "example/old", worktree: "old", branch: "old", group: null, prompt: "prompts/L9.md", custom: "keep" }]; c.custom = "keep";
  saveConfig(f.root, c);
  assert.equal(await f.invoke("adopt", "--messages", "messages", "--write"), 0, f.err.join("\n"));
  const written = loadConfig(f.root); assert.equal(written.custom, "keep"); assert.equal(written.lanes[0].custom, "keep");
  assert.equal(written.lanes[1].cwd, p.cwd); assert.match(f.out.join("\n"), /L9.*missing \(preserved\)/);
  const before = snapshot(f.home);
  assert.equal(await f.invoke("adopt", "--messages", "messages", "--write"), 0, f.err.join("\n"));
  assert.deepEqual(snapshot(f.home), before); assert.equal(f.out.at(-1), "lanes.json: no changes");
});
test("cwd wins in session targeting, status and reap while managed lanes keep their basename", async () => {
  const f = fixture(); const c = defaults(f.root, f.home); const managed = join(f.home, ".worktrees/inside");
  const external = f.add("L3c"); f.add("L2", "ttys002", managed); saveConfig(f.root, c);
  assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n"));
  const written = loadConfig(f.root); const lane = written.lanes.find(l => l.id === "L3c")!;
  assert.equal(laneTarget(lane.id, written, f.root, f.ctx).cwd, external.cwd);
  assert.equal(laneDir(lane, written, f.root, f.ctx), external.cwd);
  const inside = written.lanes.find(l => l.id === "L2")!; assert.equal(inside.cwd, undefined); assert.equal(inside.worktree, "inside");
  assert.equal(laneDir(inside, written, f.root, f.ctx), managed);
  f.out.length = 0; assert.equal(await f.invoke("status"), 0, f.err.join("\n")); assert.match(f.out.join("\n"), /L3c.*101/);
  f.calls.length = 0; assert.equal(await f.invoke("reap", "L3c", "--json"), 0, f.err.join("\n"));
  assert.ok(f.calls.some(c => c.cmd === "git" && c.args.includes(external.cwd))); assert.ok(!f.calls.some(c => c.args.includes(join(f.home, ".worktrees", lane.worktree))));
});
test("newest JSONL fallback works and conflicting lease/heartbeat identities are rejected", async () => {
  const f = fixture(); const p = f.add("L18b");
  // Use a separate process with no lease to exercise newest-session discovery.
  const q = { pid: 200, cwd: join(f.home, "fallback"), tty: "ttys020", session: "fallback" }; f.rows.push(q); mkdirSync(q.cwd);
  f.put(join(sessionDirFor(q.cwd, f.ctx.piAgentDir), "fallback.jsonl"), JSON.stringify({ type: "session", id: q.session, cwd: q.cwd }) + "\n");
  f.put(join(f.ctx.piAgentDir, "user-questions/lanes/fallback.json"), JSON.stringify({ lane: "L5", sessionId: q.session }));
  f.put(join(f.home, ".pi/orch/heartbeats/bad.json"), JSON.stringify({ pid: p.pid, cwd: p.cwd, sessionId: "other" }));
  assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n"));
  assert.deepEqual(loadConfig(f.root).lanes.map(l => l.id), ["L5"]); assert.match(f.out.join("\n"), /signals disagree: session identity/);
});
test("adopt tolerates a missing managed worktrees directory and preserves missing lanes", async () => {
  const f = fixture(); f.add("L3c"); const c = defaults(f.root, f.home);
  c.worktreesDir = join(f.home, "not-created");
  c.lanes = [{ id: "L9", repo: "example/old", worktree: "old", branch: "old", group: null, prompt: "prompts/L9.md" }];
  saveConfig(f.root, c); f.ctx.realpath = realpathSync;
  assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n"));
  assert.deepEqual(loadConfig(f.root).lanes.map(l => l.id), ["L9", "L3c"]);
  assert.match(f.out.join("\n"), /L9.*missing \(preserved\)/);
});
test("suffix grammar and message parsing preserve legacy ids and reject unsafe ids", () => {
  for (const id of ["L0", "L3c", "L18b", "R-CHR", "R-CHR-CLIENT", "A".repeat(32)]) assert.ok(validNewId(id), id);
  for (const id of ["L21-917", "L3cc", "L3c4", "L3/c", "L3.c", "L3 c", "A".repeat(33), "FOO-BAR"]) assert.ok(!validNewId(id), id);
  assert.deepEqual(parseMessageName("L0-to-L3c-hello-world-1200.md"), { from: "L0", to: ["L3c"], topic: "hello-world" });
  assert.deepEqual(parseMessageName("L18b-to-L0-x.md"), { from: "L18b", to: ["L0"], topic: "x" });
  assert.deepEqual(parseMessageName("L0-to-L3c-hello-world.md"), { from: "L0", to: ["L3c"], topic: "hello-world" });
  assert.deepEqual(parseMessageName("L0-to-R-CHR-hello-world-1200.md"), { from: "L0", to: ["R-CHR"], topic: "hello-world" });
  assert.deepEqual(parseMessageName("L1-old-topic.md"), { from: "", to: ["L1"], topic: "old-topic" });
  assert.deepEqual(parseMessageName("L1-to-L0-x.md"), { from: "", to: ["L1"], topic: "to-L0-x" });
});
test("adopt preserves stored lane and coordinator entries and reports changed facts", async () => {
  for (const role of ["sub-orch", "repo-orch"] as const) {
    const f = fixture(); f.add("L3c"); const coordinator = f.add("L0", "ttys009"); const c = defaults(f.root, f.home);
    c.lanes = [{ id: "L3c", role, repo: "example/stored", branch: "stored", cwd: join(f.home, "stored"), worktree: "stored", group: null, prompt: "custom.md", custom: "keep" }];
    saveConfig(f.root, c); const before = readFileSync(join(f.root, "lanes.json"), "utf8");
    assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n"));
    assert.equal(readFileSync(join(f.root, "lanes.json"), "utf8"), before);
    const text = f.out.join("\n");
    for (const field of ["cwd", "repo", "branch"]) assert.ok(text.includes(`conflict: stored ${field}`), field);
    assert.ok(text.includes(`conflict: stored cwd ${f.root}, found ${coordinator.cwd}`));
  }
});
test("matching discoveries never downgrade stored orchestrator roles", async () => {
  for (const role of ["sub-orch", "repo-orch"] as const) {
    const f = fixture(); const p = f.add("L3c"); const c = defaults(f.root, f.home);
    c.lanes = [{ id: "L3c", role, repo: "example/repo", branch: "work", cwd: p.cwd, worktree: "custom", group: null, prompt: "custom.md" }];
    saveConfig(f.root, c); const before = readFileSync(join(f.root, "lanes.json"), "utf8");
    assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n"));
    assert.equal(readFileSync(join(f.root, "lanes.json"), "utf8"), before);
    assert.ok(!f.out.join("\n").includes("conflict:"));
  }
});
test("legacy ids load and route messages but add and adopt reject new legacy ids", async () => {
  const f = fixture(); const p = f.add("WORK-ONE"); f.add("WORK-TWO"); const c = defaults(f.root, f.home);
  c.lanes = [{ id: "WORK-ONE", repo: "example/repo", branch: "work", cwd: p.cwd, worktree: "one", group: "TEAM-OLD", prompt: "custom.md" }];
  saveConfig(f.root, c); assert.ok(validId("WORK-ONE")); assert.equal(loadConfig(f.root).lanes[0].id, "WORK-ONE");
  assert.equal(await f.invoke("send", "WORK-ONE", "hello", "--from", "L0", "-m", "hello"), 0, f.err.join("\n"));
  const backend = new FileBackend(join(f.root, "messages"), f.ctx.now);
  assert.equal((await backend.inbox("WORK-ONE")).length, 1);
  await backend.setStatus("WORK-ONE", "running"); assert.equal(await backend.status("WORK-ONE"), "running");
  assert.equal(await f.invoke("send", "L0", "reply", "--from", "WORK-ONE", "-m", "reply"), 0, f.err.join("\n"));
  assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n"));
  assert.deepEqual(loadConfig(f.root).lanes.map(l => l.id), ["WORK-ONE"]);
  assert.match(f.out.join("\n"), /WORK-TWO.*unsupported id, rename the lane/);
  assert.equal(await f.invoke("add", "WORK-TWO"), 2); assert.match(f.err.at(-1)!, /invalid lane id/);
});
test("discovery distinguishes a non-git directory from detached HEAD and retains origin repo", async () => {
  const f = fixture(); const notGit = f.add("L1"); f.add("L2"); const run = f.ctx.run;
  f.ctx.run = async (...input: Parameters<LanesCtx["run"]>) => {
    const [cmd, args, opts] = input;
    if (cmd !== "git") return run(cmd, args, opts);
    if (args.includes(notGit.cwd)) return result("", 128);
    return result(args.includes("remote") ? "git@github.com:example/repo.git\n" : "HEAD\n");
  };
  const rows = await discover(f.ctx, [], []);
  assert.deepEqual(rows[0].warnings, ["not a git repo"]);
  assert.deepEqual(rows[1].warnings, ["detached HEAD"]); assert.equal(rows[1].repo, "example/repo"); assert.equal(rows[1].branch, undefined);
});
test("write preserves detached and non-git lanes, roles, status and routing", async (t) => {
  const { assert } = t;
  const f = fixture(); const orch = f.add("R-CHR"); const detached = f.add("L29"); const plain = f.add("L49"); const solo = f.add("SOLO");
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => {
    if (cmd !== "git") return run(cmd, args, opts);
    if ([plain.cwd, solo.cwd].some(cwd => args.includes(cwd))) return result("", 128);
    return result(args.includes("remote") ? "git@github.com:Cratis/Chronicle.git\n" : "HEAD\n");
  };
  assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n"));
  const c = loadConfig(f.root); assert.equal(c.lanes.length, 4);
  for (const p of [orch, detached, plain, solo]) {
    const lane = c.lanes.find(l => l.cwd === p.cwd)!; assert.ok(lane); assert.ok(!("branch" in lane));
    assert.equal(lane.repo, [orch, detached].includes(p) ? "Cratis/Chronicle" : undefined);
  }
  assert.equal(c.lanes[0].role, "repo-orch");
  assert.match(f.out.join("\n"), /found=4 mapped=4 unmapped=0 conflicts=0/);
  assert.equal(await f.invoke("status"), 0, f.err.join("\n"));
  assert.ok(!f.err.join("\n").includes("no repo-orch")); assert.ok(!f.out.at(-1)!.includes("undefined"));
  assert.equal(await f.invoke("send", "L0", "report", "--from", "L29", "-m", "done"), 0);
  assert.equal(await f.invoke("send", "L0", "report", "--from", "L49", "-m", "done"), 0);
  const backend = new FileBackend(join(f.root, "messages"), f.ctx.now);
  assert.equal((await backend.inbox("R-CHR")).length, 1); assert.equal((await backend.inbox("L0")).length, 1);
  const before = readFileSync(join(f.root, "lanes.json"), "utf8");
  assert.equal(await f.invoke("adopt", "--write"), 0); assert.equal(readFileSync(join(f.root, "lanes.json"), "utf8"), before);
});
test("every omitted discovery has an explicit skipped reason", async (t) => {
  const { assert } = t;
  const f = fixture(); f.add("WORK-TWO"); f.add("L1"); f.add("L1"); f.add(undefined);
  assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n"));
  assert.deepEqual(loadConfig(f.root).lanes, []);
  const summary = f.out.join("\n");
  assert.match(summary, /WORK-TWO.*skipped: unsupported id/);
  assert.match(summary, /L1.*skipped: duplicate id/); assert.match(summary, /\?.*skipped: unmapped/);
});
test("cwd lanes may omit git identity but managed worktrees still require it", (t) => {
  const { assert } = t;
  const f = fixture(); const c = defaults(f.root, f.home);
  c.lanes = [{ id: "L1", cwd: join(f.home, "plain"), worktree: "plain", group: null, prompt: "prompts/L1.md" }];
  validate(c); delete c.lanes[0].cwd; assert.throws(() => validate(c), /repo/);
  c.lanes[0].repo = "example/repo"; assert.throws(() => validate(c), /branch/);
});
test("green-prs ignores repo-less cwd lanes", async (t) => {
  const { assert } = t;
  const f = fixture(); const c = defaults(f.root, f.home);
  c.lanes = [{ id: "L1", cwd: join(f.home, "plain"), worktree: "plain", group: null, prompt: "prompts/L1.md" }];
  saveConfig(f.root, c); f.ctx.which = cmd => cmd === "gh" ? "/bin/gh" : undefined;
  const run = f.ctx.run; f.ctx.run = async (cmd, args, opts) => cmd === "gh" ? (f.calls.push({ cmd, args }), result("[]")) : run(cmd, args, opts);
  assert.equal(await f.invoke("green-prs"), 1); assert.ok(!f.calls.some(call => call.cmd === "gh"));
  c.lanes.push({ id: "L2", repo: "example/repo", branch: "work", worktree: "l2", group: null, prompt: "prompts/L2.md" });
  saveConfig(f.root, c); assert.equal(await f.invoke("green-prs"), 0);
  assert.deepEqual(f.calls.filter(call => call.cmd === "gh").map(call => call.args[3]), ["example/repo"]);
});
test("repo-less orchestrators do not group unrelated cwd lanes", async (t) => {
  const { assert } = t;
  const f = fixture(); f.add("R-ONE"); f.add("R-TWO"); f.add("L3"); const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => cmd === "git" ? result("", 128) : run(cmd, args, opts);
  assert.equal(await f.invoke("adopt", "--write"), 0, f.err.join("\n")); assert.equal(loadConfig(f.root).lanes.length, 3);
  assert.equal(await f.invoke("status"), 0, f.err.join("\n")); assert.ok(!f.err.join("\n").includes("no repo-orch"));
  assert.equal(await f.invoke("send", "L0", "report", "--from", "L3", "-m", "done"), 0);
  const backend = new FileBackend(join(f.root, "messages"), f.ctx.now); assert.equal((await backend.inbox("L0")).length, 1);
});
test("absolute inventory worktree matching tty fills a new coordinator, not a lane", async () => {
  const f = fixture(); const p = f.add(undefined); const inv = f.inventory([`| 000 | ${p.cwd} | L0 |`]);
  const run = f.ctx.run; f.ctx.run = async (...input: Parameters<LanesCtx["run"]>) => input[0] === "git" ? result("", 128) : run(...input);
  assert.equal(await f.invoke("adopt", "--inventory", inv, "--write"), 0, f.err.join("\n"));
  const c = loadConfig(f.root); assert.deepEqual(c.lanes, []); assert.equal(c.coordinator.cwd, p.cwd);
  assert.equal(c.coordinator.tty, p.tty); assert.equal(c.coordinator.sessionId, p.session);
  assert.ok(!f.out.join("\n").includes("conflict:"));
});
test("repeatable role flags set new lane roles and warn without changing existing roles", async () => {
  const f = fixture(); f.add("L1"); f.add("L2");
  assert.equal(await f.invoke("adopt", "--role", "L1=repo-orch", "--role=L2=sub-orch", "--write"), 0, f.err.join("\n"));
  assert.deepEqual(loadConfig(f.root).lanes.map(l => l.role), ["repo-orch", "sub-orch"]);
  const before = readFileSync(join(f.root, "lanes.json"), "utf8");
  assert.equal(await f.invoke("adopt", "--role", "L1=lane", "--role", "L2=lane", "--write"), 0, f.err.join("\n"));
  assert.equal(readFileSync(join(f.root, "lanes.json"), "utf8"), before);
  assert.match(f.out.join("\n"), /conflict: stored role repo-orch, found lane/);
  assert.match(f.out.join("\n"), /conflict: stored role sub-orch, found lane/);
});
test("invalid or conflicting role assignments fail without creating config", async () => {
  const f = fixture();
  for (const flags of [["--role", "L1=bad"], ["--role", "L1=lane", "--role", "L1=sub-orch"], ["--role", "L0=repo-orch"]]) {
    assert.equal(await f.invoke("adopt", ...flags, "--write"), 2);
    assert.ok(!existsSync(join(f.root, "lanes.json")));
  }
});
test("cwd schema is absolute-only and coordinator/ALL stay reserved", () => {
  const f = fixture(); const c = defaults(f.root, f.home);
  c.lanes = [{ id: "L3c", cwd: "relative", repo: "example/repo", worktree: "one", branch: "one", group: null, prompt: "prompts/one" }];
  assert.throws(() => validate(c), /cwd/); c.lanes[0].cwd = join(f.home, "absolute"); validate(c);
  c.lanes[0].id = "L0"; assert.throws(() => validate(c), /id/);
  c.lanes[0].id = "ALL"; assert.throws(() => validate(c), /id/);
});
