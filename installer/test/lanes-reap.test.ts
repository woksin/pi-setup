import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";
import { verdict } from "../src/lanes/reap/verdict.ts";
import { sessionDirFor } from "../src/lanes/names.ts";
import { tempDir, REPO } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
export function fixture() {
  const home = tempDir("lanes-reap"); const root = join(home, "coord"); mkdirSync(root);
  const now = new Date("2026-10-23T12:00:00Z"); const c = defaults(root, home, join(home, "repos")); c.terminal.backend = "print";
  c.lanes = [{ id: "L1", repo: "example/alpha", worktree: "l1", branch: "l1", group: null, prompt: "prompts/L1.md" }];
  const cwd = join(home, "repos/.worktrees/l1"); mkdirSync(cwd, { recursive: true }); saveConfig(root, c);
  const out: string[] = []; const err: string[] = []; const calls: { cmd: string; args: string[] }[] = [];
  const result = (stdout = "", code = 0) => ({ stdout, code, stderr: "failed", timedOut: false });
  let running = true; let shared = false; let busy = ""; let foreground = true; let files = ""; let dirty = ""; let merged = false; let receiver = false;
  const head = "a".repeat(40);
  const ctx: LanesCtx = { home, cwd: root, piAgentDir: join(home, ".pi/agent"), templatesDir: join(REPO, "installer/lanes/templates"), env: {}, platform: "darwin", now: () => now, which: () => undefined,
    out: s => out.push(s), err: s => err.push(s), realpath: p => p, stdinTTY: true, readStdin: async () => "", loadModule: async () => ({}), sleep: async () => {},
    run: async (cmd, args) => { calls.push({ cmd, args });
      if (cmd === "pgrep") { const pids = processList({ running, shared, receiver }); return result(pids.join("\n"), pids.length ? 0 : 1); }
      if (cmd === "lsof") return result(args.includes("cwd") ? `p101\nn${args.includes("201") ? root : cwd}\n` : files);
      if (cmd === "ps" && args[0] === "-A") return result(`101 1 pi\n${busy}`);
      if (cmd === "ps" && args[0] === "-t") return result(foreground ? "101 S+ pi\n" : "101 S+ bash\n");
      if (cmd === "ps" && args.includes("lstart=")) return result("Fri Oct 23 09:00:00 2026");
      if (cmd === "ps" && args[0] === "-o") return result("ttys003\n");
      if (cmd === "ps") return result("", running ? 0 : 1);
      if (cmd === "git") return result(args.includes("status") ? dirty : head);
      if (cmd === "gh") return result(JSON.stringify(merged ? [{ headRefOid: head }] : []));
      return result("", 1);
    } };
  const put = (path: string, text: string, minutes = 0) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); const date = new Date(now.getTime() - minutes * 60000); utimesSync(path, date, date); return path; };
  const sessionFile = put(join(sessionDirFor(cwd, ctx.piAgentDir), "s1.jsonl"), "{}", 120);
  const lease = join(ctx.piAgentDir, "issue-work/sessions/s1-101.json"); put(lease, JSON.stringify({ sessionId: "s1", pid: 101, cwd, sessionFile, procStart: "Fri Oct 23 09:00:00 2026" }));
  const marker = put(join(root, "messages/L1-inbox.marker"), "", 10);
  const claim = (state: string, note?: string, extra = {}) => put(join(ctx.piAgentDir, "issue-work/registry.jsonl"), JSON.stringify({ repo: "example/alpha", issue: 1, state, note, sessionId: "s1", cwd, source: "tool", ...extra }) + "\n");
  return { home, root, cwd, ctx, c, out, err, calls, now, head, put, result, sessionFile, lease, marker, claim,
    setReceiver: () => receiver = true, setRunning: (v: boolean) => running = v, setShared: () => shared = true, setBusy: (v: string) => busy = v, setFiles: (v: string) => files = v, setDirty: (v: string) => dirty = v, setMerged: () => merged = true, setForeground: (v: boolean) => foreground = v,
    invoke: (...args: string[]) => main(["--dir", root, ...args], ctx),
    rows: () => JSON.parse(out.at(-1)!) as { id: string; verdict: string; reason: string }[] };
}
test("dry run is read-only except plan, explains takeover and threshold fallback", async () => {
  const f = fixture(); assert.equal(await f.invoke("reap", "--json"), 0); assert.equal(f.rows()[0].verdict, "handoff");
  assert.ok(existsSync(join(f.root, ".state/reap-plan.json"))); assert.deepEqual(readdirSync(join(f.root, ".state")), ["reap-plan.json"]);
  assert.ok(!f.calls.some(c => ["tmux", "osascript"].includes(c.cmd))); assert.ok(!f.calls.some(c => c.args.includes("fetch")));
  f.c.idle = { minutes: 150 }; saveConfig(f.root, f.c); await f.invoke("reap", "--json"); assert.match(f.rows()[0].reason, /recent write/);
});
const keepCases: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["not running", f => f.setRunning(false)], ["recent write", f => f.put(f.sessionFile, "{}", 5)],
  ["busy child", f => f.setBusy("102 101 dotnet build")], ["busy child", f => f.setBusy("102 101 pi-phase run --kind build")],
  ["job/watch", f => { const p = f.put(join(f.ctx.piAgentDir, "jobs/job.log"), "command"); f.setFiles(`n${p}\n`); }],
  ["job/watch", f => { const p = f.put(join(f.ctx.piAgentDir, "jobs/watch.log"), "# pi-jobs watch until x: gh run watch 123"); f.setFiles(`n${p}\n`); }],
  ["subagent", f => f.put(join(f.ctx.piAgentDir, "context-budget/status/sub.json"), JSON.stringify({ role: "subagent", pid: 101, phase: "working", at: f.now.toISOString() }))],
  ["unread", f => f.put(join(f.root, "messages/L0-to-L1-work-1200.md"), "hi")],
  ["in-progress claim", f => f.claim("in-progress")],
  ["declared wait", f => f.put(join(f.root, "messages/status/L1.status"), 'waiting-on "ci" until 2026-10-23T14:00:00Z')],
  ["snoozed", f => f.put(join(f.root, ".state/snooze/L1"), "2026-10-23T13:30:00Z", -90)],
  ["heartbeat working", f => { f.put(f.sessionFile, "{}", 5); f.put(join(f.home, ".pi/orch/heartbeats/s1.json"), JSON.stringify({ pid: 101, sessionId: "s1", state: "working", at: f.now.toISOString() })); }],
];
for (const [reason, setup] of keepCases) test(`keep ${reason}`, async () => { const f = fixture(); setup(f); await f.invoke("reap", "--json"); assert.equal(f.rows()[0].verdict, "keep"); assert.match(f.rows()[0].reason, new RegExp(reason)); });
const askCases: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["shared cwd", f => f.setShared()], ["session file unknown", f => rmSync(f.lease)],
  ["sessions directory", f => rmSync(dirname(f.sessionFile), { recursive: true })],
  ["process descendants", f => { const run = f.ctx.run; f.ctx.run = async (cmd, a, o) => cmd === "ps" && a[0] === "-A" ? f.result("", 1) : run(cmd, a, o); }],
  ["open files", f => { const run = f.ctx.run; f.ctx.run = async (cmd, a, o) => cmd === "lsof" && !a.includes("cwd") ? f.result("", 1) : run(cmd, a, o); }],
  ["inbox watch never ran", f => rmSync(f.marker)], ["unparseable message", f => f.put(join(f.root, "messages/mystery.md"), "?")],
  ["claim from another tool", f => f.claim("in-progress", undefined, { source: "detected" })],
  ["claim from another tool", f => f.claim("blocked", "x", { sessionId: "foreign" })],
  ["named in NOW.md", f => f.put(join(f.root, "coordinator/NOW.md"), "L1 owns the release")],
  ["signals disagree", f => f.put(join(f.home, ".pi/orch/heartbeats/s1.json"), JSON.stringify({ pid: 101, state: "working", at: f.now.toISOString() }))],
  ["foreground not the expected pi", f => f.setForeground(false)],
  ["cannot read", f => f.put(join(f.ctx.piAgentDir, "context-budget/status/bad.json"), "{")],
];
for (const [reason, setup] of askCases) test(`ask ${reason}`, async () => { const f = fixture(); setup(f); await f.invoke("reap", "--json"); assert.equal(f.rows()[0].verdict, "ask"); assert.match(f.rows()[0].reason, new RegExp(reason.replaceAll(".", "\\."))); });
test("verdict never mistakes unknown ownership or acknowledgements for finished", () => {
  assert.equal(verdict({ asks: [], keeps: [], finished: false, takeover: false }).verdict, "handoff");
  assert.equal(verdict({ asks: [], keeps: [], finished: true, takeover: false }).ground, "finished");
});
test("snooze supports relative, ISO and clear; inactive alias works", async () => {
  const f = fixture(); assert.equal(await f.invoke("snooze", "L1", "--until", "+90m"), 0);
  await f.invoke("close", "--inactive", "--json"); assert.match(f.rows()[0].reason, /snoozed/);
  assert.equal(await f.invoke("snooze", "L1", "--clear"), 0); assert.equal(existsSync(join(f.root, ".state/snooze/L1")), false);
  assert.equal(await f.invoke("snooze", "L1", "--until", "2026-10-24T00:00:00Z"), 0);
  assert.equal(await f.invoke("snooze", "L1", "--until", "bad"), 2);
});

test("handoff pack and explicit acceptance are resumable and read-only for claims", async () => {
  const f = fixture(); f.setReceiver(); f.claim("blocked", "needs fresh owner");
  assert.equal(await f.invoke("handoff", "L1", "--to", "L0"), 0);
  const plan = JSON.parse(readFileSync(join(f.root, ".state/reap-plan.json"), "utf8")); const path = plan.rows[0].pack;
  assert.ok(path); assert.ok(existsSync(join(f.root, path, "handoff.json")));
  assert.match(readFileSync(join(f.root, path, "HANDOFF.md"), "utf8"), /claims/i);
  const registry = readFileSync(join(f.ctx.piAgentDir, "issue-work/registry.jsonl"), "utf8");
  assert.equal(await f.invoke("handoff", "L1", "--accept", "--from", "L0"), 0);
  const pack = JSON.parse(readFileSync(join(f.root, path, "handoff.json"), "utf8")); assert.equal(pack.acceptance.from, "L0");
  assert.equal(readFileSync(join(f.ctx.piAgentDir, "issue-work/registry.jsonl"), "utf8"), registry);
  assert.equal(await f.invoke("handoff", "L1", "--accept", "--from", "NO"), 2);
});
test("apply without acceptance sends request, but never quits or archives", async () => {
  const f = fixture(); f.setReceiver(); assert.equal(await f.invoke("reap", "L1", "--apply", "--handoff-to", "L0", "--json"), 0);
  assert.equal(f.rows()[0].verdict, "handoff"); assert.ok(existsSync(join(f.root, ".state/handoffs/L1/handoff.json")));
  assert.ok(!f.calls.some(c => c.cmd === "tmux" || c.cmd === "osascript")); assert.equal(loadRetired(f), false);
});
function loadRetired(f: ReturnType<typeof fixture>) { return Boolean(JSON.parse(readFileSync(join(f.root, "lanes.json"), "utf8")).lanes[0].retired); }
async function accepted(f: ReturnType<typeof fixture>) { f.setReceiver(); assert.equal(await f.invoke("handoff", "L1", "--to", "L0"), 0); assert.equal(await f.invoke("handoff", "L1", "--accept", "--from", "L0"), 0); }
function quitRunner(f: ReturnType<typeof fixture>, exit = true, mutate?: () => void) {
  f.ctx.env.TMUX = "test"; f.ctx.which = cmd => cmd === "tmux" ? "/usr/bin/tmux" : undefined; const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => {
    if (cmd === "tmux" && args[0] === "list-panes") { mutate?.(); return f.result("/dev/ttys003 %1\n"); }
    if (cmd === "tmux" && args[0] === "send-keys") { if (exit) f.setRunning(false); return f.result(); }
    return run(cmd, args, opts);
  };
}
test("accepted takeover quits via terminal, archives evidence and preserves work and identity", async () => {
  const f = fixture(); await accepted(f); f.put(join(f.cwd, "dirty.txt"), "keep me"); f.setDirty(" M dirty.txt");
  // Pack must cover the final dirty state, not an older acceptance.
  await f.invoke("handoff", "L1", "--to", "L0"); await f.invoke("handoff", "L1", "--accept", "--from", "L0");
  const prompt = f.put(join(f.root, "prompts/L1.md"), "brief"); const identity = f.put(join(f.home, ".pi/pi-questions/identities.json"), '{"L1":"s1"}');
  f.put(join(f.root, "messages/status/L1.status"), "ready"); f.put(join(f.root, "messages/L0-to-L1-task-1100.md"), "old", 30);
  await f.invoke("handoff", "L1", "--to", "L0"); await f.invoke("handoff", "L1", "--accept", "--from", "L0");
  quitRunner(f); assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 0); assert.equal(f.rows()[0].verdict, "retire");
  assert.equal(loadRetired(f), true); assert.equal(existsSync(prompt), false); assert.ok(existsSync(join(f.cwd, "dirty.txt"))); assert.equal(readFileSync(identity, "utf8"), '{"L1":"s1"}');
  const retire = readdirSync(join(f.root, ".state/retired"))[0]; const archive = join(f.root, ".state/retired", retire, "L1");
  assert.ok(existsSync(join(archive, "prompts/L1.md"))); assert.ok(existsSync(join(archive, "handoff/handoff.json"))); assert.ok(existsSync(join(archive, "closure.json")));
  const once = f.calls.filter(c => c.cmd === "tmux" && c.args[0] === "send-keys").length;
  assert.equal(await f.invoke("reap", "--apply", "--json"), 0); assert.equal(f.calls.filter(c => c.cmd === "tmux" && c.args[0] === "send-keys").length, once);
});
test("quit timeout leaves metadata active and acceptance available", async () => {
  const f = fixture(); await accepted(f); quitRunner(f, false); assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 2);
  assert.equal(loadRetired(f), false); assert.equal(existsSync(join(f.root, ".state/retired")), false);
  assert.match(f.rows()[0].reason, /did not exit/); assert.ok(existsSync(join(f.root, ".state/handoffs/L1/handoff.json")));
});
test("new write after plan/acceptance and foreground drift invalidate closure", async () => {
  const f = fixture(); await accepted(f); quitRunner(f, true, () => f.put(f.sessionFile, "new work", 1));
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 2); assert.equal(loadRetired(f), false);
  assert.ok(!f.calls.some(c => c.cmd === "tmux" && c.args[0] === "send-keys"));
  const g = fixture(); await accepted(g); quitRunner(g, true, () => g.setForeground(false)); await g.invoke("reap", "L1", "--apply", "--json"); assert.equal(loadRetired(g), false);
});
test("bad or failed recipient is rejected without quit; retired starts fail; orphan children block", async () => {
  const f = fixture(); assert.equal(await f.invoke("handoff", "L1", "--to", "NO"), 2); assert.equal(await f.invoke("handoff", "L1", "--to", "L0"), 2);
  f.c.lanes[0].retired = true; saveConfig(f.root, f.c); assert.equal(await f.invoke("start", "L1"), 1); assert.match(f.err.at(-1)!, /retired/);
  const g = fixture(); await accepted(g); g.c.lanes.push({ ...g.c.lanes[0], id: "L2", worktree: "l2", parent: "L1" }); saveConfig(g.root, g.c); quitRunner(g);
  assert.equal(await g.invoke("reap", "L1", "--apply", "--json"), 2); assert.equal(loadRetired(g), false);
});

function processList(state: { running: boolean; shared: boolean; receiver: boolean }): number[] {
  const pids = state.running ? state.shared ? [101, 102] : [101] : [];
  if (state.receiver) pids.push(201); return pids;
}
test("newer unrelated JSONL never substitutes for current session identity", async () => {
  const f = fixture(); f.put(join(dirname(f.sessionFile), "s2.jsonl"), "{}", 1);
  await f.invoke("reap", "--json"); assert.equal(f.rows()[0].verdict, "handoff");
});
test("PID reuse, failed process discovery, registry corruption and stale heartbeats fail closed", async () => {
  const f = fixture(); f.put(f.lease, JSON.stringify({ sessionId: "s1", pid: 101, cwd: f.cwd, sessionFile: f.sessionFile, procStart: "old process" }));
  await f.invoke("reap", "--json"); assert.equal(f.rows()[0].verdict, "ask"); assert.match(f.rows()[0].reason, /lease\/process/);
  const g = fixture(); g.put(join(g.ctx.piAgentDir, "issue-work/registry.jsonl"), "{"); await g.invoke("reap", "--json"); assert.equal(g.rows()[0].verdict, "ask");
  const h = fixture(); h.put(join(h.home, ".pi/orch/heartbeats/s1.json"), JSON.stringify({ pid: 101, sessionId: "s1", state: "idle", at: "2026-10-23T01:00:00Z" })); await h.invoke("reap", "--json"); assert.equal(h.rows()[0].verdict, "ask");
  const j = fixture(); const run = j.ctx.run; j.ctx.run = async (cmd, args, opts) => cmd === "pgrep" ? { ...j.result(), timedOut: true } : run(cmd, args, opts); await j.invoke("reap", "--json"); assert.equal(j.rows()[0].verdict, "ask");
});
test("in-review even at a merged HEAD requires takeover rather than inferred acknowledgement", async () => {
  const f = fixture(); f.claim("in-review"); f.setMerged(); await f.invoke("reap", "--json"); assert.equal(f.rows()[0].verdict, "handoff");
  const g = fixture(); g.claim("blocked"); await g.invoke("reap", "--json"); assert.equal(g.rows()[0].verdict, "ask");
});
test("late descendants and inbox activity prevent a quit after acceptance", async () => {
  for (const activity of [(f: ReturnType<typeof fixture>) => f.setBusy("102 101 npm test"), (f: ReturnType<typeof fixture>) => f.put(join(f.root, "messages/L0-to-L1-new-1200.md"), "new")]) {
    const f = fixture(); await accepted(f); quitRunner(f, true, () => activity(f)); await f.invoke("reap", "L1", "--apply", "--json");
    assert.equal(loadRetired(f), false); assert.ok(!f.calls.some(c => c.cmd === "tmux" && c.args[0] === "send-keys"));
  }
});
