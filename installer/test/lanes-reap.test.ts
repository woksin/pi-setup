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
  let running = true; let shared = false; let busy = ""; let foreground = true; let files = ""; let dirty = ""; let merged = false;
  const head = "a".repeat(40);
  const ctx: LanesCtx = { home, cwd: root, piAgentDir: join(home, ".pi/agent"), templatesDir: join(REPO, "installer/lanes/templates"), env: {}, platform: "darwin", now: () => now, which: () => undefined,
    out: s => out.push(s), err: s => err.push(s), realpath: p => p, stdinTTY: true, readStdin: async () => "", loadModule: async () => ({}), sleep: async () => {},
    run: async (cmd, args) => { calls.push({ cmd, args });
      if (cmd === "pgrep") return result(running ? shared ? "101\n102\n" : "101\n" : "", running ? 0 : 1);
      if (cmd === "lsof") return result(args.includes("cwd") ? `p101\nn${cwd}\n` : files);
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
    setRunning: (v: boolean) => running = v, setShared: () => shared = true, setBusy: (v: string) => busy = v, setFiles: (v: string) => files = v, setDirty: (v: string) => dirty = v, setMerged: () => merged = true, setForeground: (v: boolean) => foreground = v,
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
