import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";
import { treeDigest } from "../src/lanes/reap/tree.ts";
import { processEvidence } from "../src/lanes/reap/process.ts";
import { collect, type Signals } from "../src/lanes/reap/signals.ts";
import { expectedSnapshot, readContext, validateContext } from "../src/lanes/reap/context-format.ts";
import { verdict } from "../src/lanes/reap/verdict.ts";
import { sessionDirFor } from "../src/lanes/names.ts";
import { scanSession } from "../src/lanes/reap/session-scan.ts";
import { summaryLine } from "../src/lanes/reap/summary.ts";
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
      if (cmd === "ps") {
        const probe = foregroundProbe({ args, foreground, busy });
        if (probe !== undefined) return result(probe);
      }
      if (cmd === "ps" && args[0] === "-A") return result(`101 1 pi\n${busy}`);
      if (cmd === "ps" && args.includes("lstart=")) return result("Fri Oct 23 09:00:00 2026");
      if (cmd === "ps" && args[0] === "-o") return result("ttys003\n");
      if (cmd === "ps") return result("", running ? 0 : 1);
      if (cmd === "git") return result(args.some(a => a.startsWith("--porcelain")) ? dirty ? dirty + "\0" : "" : head);
      if (cmd === "gh") return result(JSON.stringify(merged ? [{ headRefOid: head }] : []));
      return result("", 1);
    } };
  const put = (path: string, text: string, minutes = 0) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); const date = new Date(now.getTime() - minutes * 60000); utimesSync(path, date, date); return path; };
  const sessionFile = put(join(sessionDirFor(cwd, ctx.piAgentDir), "s1.jsonl"), "{}", 120);
  const lease = join(ctx.piAgentDir, "issue-work/sessions/s1-101.json"); put(lease, JSON.stringify({ sessionId: "s1", pid: 101, cwd, sessionFile, procStart: "Fri Oct 23 09:00:00 2026" }));
  const marker = put(join(root, "messages/L1-inbox.marker"), "", 10);
  const claim = (state: string, note?: string, extra = {}) => put(join(ctx.piAgentDir, "issue-work/registry.jsonl"), JSON.stringify({ repo: "example/alpha", issue: 1, state, note, sessionId: "s1", cwd, source: "tool", ...extra }) + "\n");
  return { home, root, cwd, ctx, c, out, err, calls, now, head, put, result, sessionFile, lease, marker, claim,
    getDirty: () => dirty, setReceiver: () => receiver = true, setRunning: (v: boolean) => running = v, setShared: () => shared = true, setBusy: (v: string) => busy = v, setFiles: (v: string) => files = v, setDirty: (v: string) => dirty = v, setMerged: () => merged = true, setForeground: (v: boolean) => foreground = v,
    invoke: (...args: string[]) => main(["--dir", root, ...args], ctx),
    rows: () => JSON.parse(out.at(-1)!) as { id: string; verdict: string; reason: string }[] };
}
function subagentStatus(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}, name = "sub"): void {
  f.put(join(f.ctx.piAgentDir, `context-budget/status/${name}.json`), JSON.stringify({
    role: "subagent", sessionId: "child-session", sessionFile: "/sessions/child.jsonl", pid: 101,
    at: f.now.toISOString(), ...overrides,
  }));
}
function agentLaunch(agentId = "agent1", callId = "call1"): string {
  return [
    { role: "assistant", content: [{ type: "toolCall", name: "Agent", id: callId, arguments: { subagent_type: "reviewer", prompt: "review" } }] },
    { role: "toolResult", toolName: "Agent", toolCallId: callId, details: { status: "background", agentId } },
  ].map(entry => JSON.stringify({ type: "message", message: entry })).join("\n") + "\n";
}
function foregroundProbe({ args, foreground, busy }: { args: string[]; foreground: boolean; busy: string }): string | undefined {
  if (args.includes("pgid=,tpgid=")) return "101 101\n";
  if (args.includes("pid=,ppid=,pgid=,command=")) return `101 1 101 ${foreground ? "pi" : "bash"}\n${busy.replace(/^(\d+) (\d+) /gm, "$1 $2 102 ")}`;
  if (args[0] === "-t") return foreground ? "101 S+ pi\n" : "101 S+ bash\n";
}
const liveTty = `41515 Ss   login -pf sindrewilting
41516 S    -zsh
43656 S+   bash /Users/sindrewilting/.local/bin/pi-session --name L49 @/Volumes/work
43835 S+   pi
44484 S+   chrome-devtools-mcp
44502 S+   /Users/bin/donsetch mcp --supervised
44504 S+   /Users/bin/donsetch mcp`;
const liveTree = `41515 1 41515 login -pf sindrewilting
41516 41515 41516 -zsh
43656 41516 43656 bash /Users/sindrewilting/.local/bin/pi-session --name L49 @/Volumes/work
43835 43656 43656 pi
44484 43835 43656 chrome-devtools-mcp
44502 43835 43656 /Users/bin/donsetch mcp --supervised
44504 44502 43656 /Users/bin/donsetch mcp`;
for (const variant of ["wrapper and MCP", "vim", "foreign", "background pi", "wrong command", "missing pi", "malformed group"]) {
  test(`foreground process group: ${variant}`, async () => {
    const f = fixture(); const run = f.ctx.run;
    const extra = variant === "vim" ? "50000 43656 43656 vim" : variant === "foreign" ? "50000 1 43656 foreign" : "";
    let tree = liveTree + (extra ? `\n${extra}` : "");
    if (variant === "wrong command") tree = tree.replace("43835 43656 43656 pi", "43835 43656 43656 not-pi");
    if (variant === "missing pi") tree = tree.split("\n").filter(line => !line.startsWith("43835 ")).join("\n");
    const probes = new Map([
      ["pgid=,tpgid=", variant === "background pi" ? "43656 50000" : variant === "malformed group" ? "? ?" : "43656 43656"],
      ["pid=,ppid=,pgid=,command=", tree], ["-t", liveTty + (extra ? `\n50000 S+ ${variant}` : "")],
    ]);
    f.ctx.run = async (cmd, args, opts) => {
      const output = probes.get(args.find(arg => probes.has(arg)) ?? "");
      return cmd === "ps" && output !== undefined ? f.result(output) : run(cmd, args, opts);
    };
    const signals = { pid: 43835, keeps: [] } as unknown as Signals;
    if (variant === "wrapper and MCP") await processEvidence(signals, f.ctx);
    else await assert.rejects(processEvidence(signals, f.ctx), /foreground not the expected pi/);
  });
}
function evidence(f: ReturnType<typeof fixture>) {
  return collect({ c: f.c, lane: f.c.lanes[0], root: f.root, ctx: f.ctx, minutes: 75 });
}
test("watcher epoch markers and filename grammar preserve unread evidence", async () => {
  for (const name of ["L0-to-L1-x.md", "20261023-120000-L1-from-L0-x.md", "L1-L2-x.md", "ALL-x.md", "legacy-L1-odd.md"]) {
    const f = fixture(); rmSync(f.marker);
    f.put(join(f.root, ".state/inbox-L1.marker"), String(f.now.getTime() / 1000 - 60));
    f.put(join(f.root, "messages", name), "hello");
    const s = await evidence(f); assert.ok(s.keeps.includes("unread inbox"), name);
    assert.ok(!s.asks.some(reason => reason.includes("marker")), name);
  }
});
test("old mail stays read and malformed or future watcher markers fail closed", async () => {
  const f = fixture(); f.put(join(f.root, "messages/L0-to-L1-hello.md"), "hello", 20);
  assert.ok(!(await evidence(f)).keeps.includes("unread inbox"));
  for (const value of ["bad", String(f.now.getTime() / 1000 + 60)]) {
    f.put(join(f.root, ".state/inbox-L1.marker"), value);
    assert.ok((await evidence(f)).asks.includes("inbox marker invalid"));
  }
});
const liveMessageNames = [
  ["R-CHR-to-L44-5340-ok-1710.md", "L44"],
  ["L41-to-L19-stage-deliver-721-0a.md", "L19"],
  ["L0-to-ai-skills-1406-resume.md", "ai-skills"],
  ["L34-chronicle-correctness-to-L0-5177-merged.md", "L0"],
  ["20261023-041109-L15-to-L0-L29-L33-L36-L45-v0.280.1-deployed.md", "L36"],
  ["20261023-070746-RETRO-to-L24-L0-cand2-guard-advisory-fixed.md", "L24"],
  ["20261023-075216-L15-to-L46-2400-review.md", "L46"],
  ["20261023-0555-L46-to-L15-189-cratis-bot.md", "L15"],
];
test("live message names count only when newer than marker or session activity", async () => {
  for (const [name, id] of liveMessageNames) for (const marker of [true, false]) {
    const f = fixture(); f.c.lanes[0].id = id; rmSync(f.marker);
    if (marker) f.put(join(f.root, `messages/${id}-inbox.marker`), "", 10);
    const path = join(f.root, "messages", name); f.put(path, "fixture", 180);
    const old = await evidence(f); assert.deepEqual(old.asks, [], name); assert.deepEqual(old.unread, [], name);
    f.put(path, "fixture"); const fresh = await evidence(f); assert.deepEqual(fresh.unread, [name], name);
    if (!marker) assert.ok(fresh.asks.includes("pending inbound; inbox marker and watch evidence missing"));
  }
});
test("missing marker is only a JSON note until pending inbound needs watch evidence", async () => {
  const f = fixture(); rmSync(f.marker); const initial = await evidence(f);
  assert.deepEqual(initial.asks, []); assert.deepEqual(initial.notes, ["inbox marker missing"]);
  assert.equal(verdict(initial).verdict, "handoff");
  f.put(join(f.root, "messages/L0-to-L1-work.md"), "fixture");
  assert.ok((await evidence(f)).asks.includes("pending inbound; inbox marker and watch evidence missing"));
  for (const command of ["inbox-watch L1", "~/.pi/agent/bin/inbox-watch --alias ttys003 L1"]) {
    f.put(f.sessionFile, JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "job_watch", details: { command } } }), 120);
    const watched = await evidence(f); assert.equal(watched.inboxWatch, true); assert.deepEqual(watched.asks, []);
    assert.ok(watched.keeps.includes("unread inbox"));
  }
  f.put(f.sessionFile, JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "job_watch", details: { command: "inbox-watch L10" } } }), 120);
  assert.equal((await evidence(f)).inboxWatch, undefined);
});
test("watch aliases and INBOX_ALIASES count pending inbound only for the lane", async () => {
  for (const command of ["inbox-watch --alias R-AI --alias ttys003 L1", "INBOX_ALIASES=R-AI,ttys003 inbox-watch L1"]) {
    const f = fixture();
    f.put(f.sessionFile, JSON.stringify({ role: "toolResult", toolName: "job_watch", details: { command } }), 120);
    f.put(join(f.root, "messages/L0-to-R-AI-work.md"), "fixture");
    f.put(join(f.root, "messages/L0-to-ttys003-work.md"), "fixture");
    const s = await evidence(f); assert.equal(s.unread.length, 2, command);
    assert.ok(s.keeps.includes("unread inbox"));
    f.put(f.sessionFile, JSON.stringify({ role: "toolResult", toolName: "job_watch", details: { command: command.replace(" L1", " L10") } }), 120);
    assert.deepEqual((await evidence(f)).unread, []);
  }
  const f = fixture(); f.ctx.env.INBOX_ALIASES = "R-AI,ttys003";
  f.put(join(f.root, "messages/L0-to-R-AI-work.md"), "fixture");
  assert.deepEqual((await evidence(f)).unread, ["L0-to-R-AI-work.md"]);
});
test("claim mapping is independent of source and foreign claims appear only in summary", async () => {
  for (const extra of [{ sessionId: "foreign", branch: "l1", cwd: "/other" }, { sessionId: "foreign", cwd: "CWD" }, { source: "detected" }]) {
    const f = fixture(); f.claim("in-progress", undefined, { ...extra, ...(extra.cwd === "CWD" ? { cwd: f.cwd } : {}) });
    const s = await evidence(f); assert.deepEqual(s.asks, []); assert.ok(s.keeps.includes("in-progress claim"));
  }
  const f = fixture(); f.claim("in-progress", undefined, { sessionId: "foreign", branch: "other", cwd: "/other" });
  await f.invoke("reap", "--json"); assert.equal(f.rows()[0].verdict, "handoff");
  const plan = JSON.parse(readFileSync(join(f.root, ".state/reap-plan.json"), "utf8"));
  assert.deepEqual(plan.summaries.find(item => item.label === "Foreign claims").names, ["example/alpha#1"]);
});
test("whole-session folding retains early jobs, watches and pending calls beyond the old tail", async () => {
  const f = fixture();
  const job = { id: "j-before", status: "running", command: "inbox-watch --alias R-AI L1", cwd: f.cwd, startedAt: f.now.getTime() - 120000, timeoutSeconds: 3600 };
  const result = (toolName: string, details: object) => JSON.stringify({ type: "message", message: { role: "toolResult", toolName, details } });
  const call = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "pending", name: "subagent" }] } });
  const padding = `${JSON.stringify({ padding: "x".repeat(1024) })}\n`.repeat(34000);
  const history = `${agentLaunch()}${result("job_watch", job)}\n${call}\n${padding}`;
  f.put(f.sessionFile, history, 120);
  const active = await evidence(f);
  assert.deepEqual(active.asks, ["subagent launched without completion"]); assert.ok(active.keeps.includes("job/watch running (session snapshot)"));
  assert.ok(active.keeps.includes("subagent tool call pending")); assert.equal(active.inboxWatch, true);
  assert.deepEqual(active.inboxAliases, ["R-AI"]);
  const notification = JSON.stringify({ customType: "subagent-notification", details: { status: "completed", id: "agent1" } });
  f.put(f.sessionFile, `${history}${result("job_output", { id: job.id, status: "completed" })}\n${JSON.stringify({ role: "toolResult", toolCallId: "pending" })}\n${notification}\n`, 120);
  const completed = await evidence(f); assert.deepEqual(completed.asks, []);
  assert.ok(!completed.keeps.some(reason => /job\/watch|tool call pending/.test(reason)));
});
test("session scans fail closed at size and time bounds and on malformed history", async () => {
  const f = fixture();
  await assert.rejects(scanSession(f.sessionFile, () => {}, { bytes: 1, milliseconds: 5000 }), /session scan incomplete/);
  await assert.rejects(scanSession(f.sessionFile, () => {}, { bytes: 1024, milliseconds: 0 }), /session scan incomplete/);
  truncateSync(f.sessionFile, 256 * 1024 * 1024 + 1);
  assert.deepEqual((await evidence(f)).asks, ["session scan incomplete"]);
  f.put(f.sessionFile, "{malformed\n{}\n", 120);
  assert.deepEqual((await evidence(f)).asks, ["session work history malformed"]);
  f.put(f.sessionFile, JSON.stringify({ role: "toolResult", toolName: "job_output", details: { id: "j1", status: "running" } }), 120);
  assert.deepEqual((await evidence(f)).asks, ["job j1 start evidence missing"]);
});
test("summary samples are capped while saved lists remain complete", async () => {
  const f = fixture();
  for (let i = 0; i < 14; i++) f.put(join(f.root, `messages/unknown-${i}.md`), "fixture");
  await f.invoke("reap"); const line = f.out.find(line => line.startsWith("Unparseable messages"))!;
  assert.ok(line.endsWith("(+4 more)"));
  const plan = JSON.parse(readFileSync(join(f.root, ".state/reap-plan.json"), "utf8"));
  assert.equal(plan.summaries[0].names.length, 14); assert.equal(line, summaryLine(plan.summaries[0]));
});
test("missing worktree has a lane-specific human reason", async () => {
  const f = fixture(); const realpath = f.ctx.realpath;
  f.ctx.realpath = path => { if (path !== f.cwd) return realpath(path); throw Object.assign(new Error("raw lstat error"), { code: "ENOENT" }); };
  assert.deepEqual((await evidence(f)).asks, [`worktree gone: ${f.cwd}`]);
});
test("local active claims require exact identity rather than branch substrings", async () => {
  for (const [fields, keep] of [["**Session:** s1", true], ["**Worktree:** CWD", true], ["**Branch:** l1", true], ["**Repo:** example/alpha\n**Issue:** #1", true], ["**Branch:** work\n**Issue:** #170", false]] as const) {
    const f = fixture(); f.c.lanes[0].issue = 1;
    f.put(join(f.cwd, ".ai-work/issue-work/1/status.md"), `**State:** in-progress\n${fields.replace("CWD", f.cwd)}`);
    const s = await evidence(f); assert.equal(s.keeps.includes("in-progress local claim"), keep, fields);
    if (!keep) assert.ok(s.asks.includes("local claim ownership unknown"));
  }
});
test("real-shaped child records belong by primary session or legacy shared host pid", async () => {
  const f = fixture();
  for (const identity of [{}, { primarySessionId: "s1", state: "active" }, { primarySessionId: "s1", pid: 909 }]) {
    subagentStatus(f, identity); const s = await evidence(f);
    assert.deepEqual(s.asks, []); assert.deepEqual(s.keeps, ["subagent running"]);
  }
  assert.ok(!f.calls.some(c => c.args.includes("pid=")));
});
test("explicit primary mismatch never falls back to host pid; cwd and child ancestry do not establish ownership", async () => {
  const f = fixture();
  for (const identity of [{ primarySessionId: "s10" }, { primarySessionId: null }, { pid: 909, cwd: f.cwd }, { pid: 909, cwd: join(f.cwd, "child") }, { pid: 909, sessionId: "s1", sessionFile: f.sessionFile, parentPid: 101 }, { role: "main", primarySessionId: "s1" }]) {
    subagentStatus(f, { at: "unknown", ...identity }); const s = await evidence(f);
    assert.deepEqual(s.asks, []); assert.deepEqual(s.keeps, []);
  }
});
test("ended children are history even with unknown timestamps; active fresh and boundary timestamps keep", async () => {
  const f = fixture();
  for (const identity of [{}, { primarySessionId: "s1" }]) {
    subagentStatus(f, { ...identity, state: "ended", at: "unknown" });
    assert.deepEqual((await evidence(f)).asks, []); assert.deepEqual((await evidence(f)).keeps, []);
    subagentStatus(f, { ...identity, state: "active", at: new Date(f.now.getTime() - 600000).toISOString() });
    assert.deepEqual((await evidence(f)).keeps, ["subagent running"]);
  }
});
test("stale legacy and invalid status records are history, not doubt or liveness", async () => {
  const f = fixture();
  for (const at of ["2020-01-01T00:00:00Z", "unknown", undefined, new Date(f.now.getTime() + 1000).toISOString()]) {
    subagentStatus(f, { at }); const s = await evidence(f);
    assert.deepEqual(s.asks, []); assert.deepEqual(s.keeps, []);
  }
  for (let i = 0; i < 20; i++) subagentStatus(f, { primarySessionId: "s1", at: "unknown" }, `unknown${i}`);
  for (let i = 0; i < 20; i++) subagentStatus(f, { state: "active" }, `fresh${i}`);
  const s = await evidence(f); assert.deepEqual(s.asks, []); assert.deepEqual(s.keeps, ["subagent running"]);
});
test("Agent launches without matching completion notifications ask once per lane", async () => {
  const f = fixture(); f.put(f.sessionFile, agentLaunch() + agentLaunch("agent2", "call2"), 120);
  subagentStatus(f, { at: "2020-01-01T00:00:00Z", state: "ended" });
  assert.deepEqual((await evidence(f)).asks, ["subagent launched without completion"]);
  f.put(f.sessionFile, JSON.stringify({ role: "assistant", content: [{ type: "toolCall", name: "Agent", id: "call1" }] }), 120);
  assert.deepEqual((await evidence(f)).asks, ["subagent launched without completion"]);
});
test("matching terminal task notifications settle Agent launches by exact agent id", async () => {
  const f = fixture();
  const completions = [
    { type: "custom_message", customType: "subagent-notification", details: { status: "completed", id: "agent&1" } },
    { role: "custom", customType: "subagent-notification", details: { status: "failed", agentId: "agent&1" } },
    { type: "custom_message", customType: "subagent-notification", content: "<task-notification><task-id>agent&amp;1</task-id><status>Done</status></task-notification>" },
    { type: "custom_message", customType: "subagent-notification", content: [{ type: "text", text: "<task-notification><task-id>agent&amp;1</task-id><status>Aborted</status></task-notification>" }] },
  ];
  for (const completion of completions) {
    f.put(f.sessionFile, agentLaunch("agent&1") + JSON.stringify(completion), 120);
    const s = await evidence(f); assert.deepEqual(s.asks, []); assert.deepEqual(s.keeps, []);
  }
});
test("unrelated, running, quoted and tool-receipt messages are not Agent completion notifications", async () => {
  const f = fixture();
  const completions = [
    { type: "custom_message", customType: "subagent-notification", details: { status: "completed", id: "agent10" } },
    { type: "custom_message", customType: "subagent-notification", content: "<task-notification><task-id>agent1</task-id><status>Running</status></task-notification>" },
    { role: "toolResult", toolName: "get_subagent_result", details: { status: "completed", agentId: "agent1" } },
    { role: "user", content: "<task-notification><task-id>agent1</task-id><status>Done</status></task-notification>" },
  ];
  for (const completion of completions) {
    f.put(f.sessionFile, agentLaunch() + JSON.stringify(completion), 120);
    assert.deepEqual((await evidence(f)).asks, ["subagent launched without completion"]);
  }
});
test("Agent text receipts expose ids, launch failures do not leave pending work, partial scans still ask", async () => {
  const f = fixture(); const call = JSON.stringify({ role: "assistant", content: [{ type: "toolCall", name: "Agent", id: "call1" }] }) + "\n";
  const receipt = { role: "toolResult", toolName: "Agent", toolCallId: "call1", content: [{ type: "text", text: "Agent started in background.\nAgent ID: agent1\n" }] };
  f.put(f.sessionFile, call + JSON.stringify(receipt) + "\n" + JSON.stringify({ customType: "subagent-notification", details: { status: "completed", id: "agent1" } }), 120);
  assert.deepEqual((await evidence(f)).asks, []);
  f.put(f.sessionFile, call + JSON.stringify({ ...receipt, isError: true }), 120);
  assert.deepEqual((await evidence(f)).asks, []);
  f.put(f.sessionFile, agentLaunch() + "{broken", 120);
  assert.deepEqual((await evidence(f)).asks, ["session work history malformed"]);
});
test("fresh subagent activity keeps a lane while unmatched launches and claim doubts remain notes", async () => {
  const f = fixture(); f.put(f.sessionFile, agentLaunch(), 120); subagentStatus(f); f.claim("blocked");
  const output: string[] = []; f.ctx.out = text => output.push(text);
  await f.invoke("reap"); const row = JSON.parse(readFileSync(join(f.root, ".state/reap-plan.json"), "utf8")).rows[0]; assert.equal(row.verdict, "keep");
  assert.ok(row.notes.includes("subagent launched without completion")); assert.ok(row.notes.some((note: string) => note.includes("claim")));
  assert.ok(output.some(line => line.includes("[notes: subagent launched without completion")));
});
test("job snapshots cover sleeping watches and terminal updates clear them", async () => {
  const f = fixture(); const snapshot = { id: "j1", command: "inbox-watch L1", status: "running", cwd: f.cwd, startedAt: f.now.getTime() - 120000, timeoutSeconds: 3600 };
  const lines = [{ type: "message", message: { role: "toolResult", toolName: "job_watch", details: snapshot } }];
  f.put(f.sessionFile, lines.map(line => JSON.stringify(line)).join("\n"), 120);
  assert.ok((await evidence(f)).keeps.includes("job/watch running (session snapshot)"));
  lines.push({ type: "message", message: { role: "toolResult", toolName: "job_output", details: { ...snapshot, status: "matched" } } });
  f.put(f.sessionFile, lines.map(line => JSON.stringify(line)).join("\n"), 120);
  assert.ok(!(await evidence(f)).keeps.some(reason => reason.startsWith("job/watch")));
});
test("keep beats ask and retains all uncertainty as deduplicated notes", () => {
  for (const keep of ["subagent running", "busy child process", "job/watch running (log open)", "job/watch running (session snapshot)"]) {
    const decision = verdict({ asks: ["doubt", "doubt", "claim"], keeps: [keep], finished: true, takeover: true });
    assert.equal(decision.verdict, "keep"); assert.equal(decision.ground, undefined); assert.deepEqual(decision.notes, ["doubt", "claim"]);
  }
});
test("reason classes are deduplicated without history counts", () => {
  assert.equal(verdict({ asks: ["uncertain", "uncertain", "claim", "claim"], keeps: [], finished: false, takeover: false }).reason, "uncertain; claim");
  assert.equal(verdict({ asks: [], keeps: ["subagent running", "subagent running"], finished: false, takeover: false }).reason, "subagent running");
});
test("human reasons are bounded while raw asks remain complete", () => {
  const asks = Array.from({ length: 8 }, (_, i) => `lane evidence ${i}`);
  assert.equal(verdict({ asks, keeps: [], finished: false, takeover: false }).reason.split("; ").length, 3);
  assert.equal(asks.length, 8);
});
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
  ["subagent", f => subagentStatus(f, { primarySessionId: "s1", state: "active" })],
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
  ["pending inbound", f => { rmSync(f.marker); f.put(join(f.root, "messages/L0-to-L1-pending.md"), "fixture"); }],
  ["message name ambiguous", f => f.put(join(f.root, "messages/mystery-L1-123.md"), "?")],
  ["named in NOW.md", f => f.put(join(f.root, "coordinator/NOW.md"), "L1 owns the release")],
  ["signals disagree", f => f.put(join(f.home, ".pi/orch/heartbeats/s1.json"), JSON.stringify({ pid: 101, state: "working", at: f.now.toISOString() }))],
  ["foreground not the expected pi", f => f.setForeground(false)],
  ["cannot read", f => f.put(join(f.ctx.piAgentDir, "context-budget/status/bad.json"), "{")],
];
for (const [reason, setup] of askCases) test(`ask ${reason}`, async () => { const f = fixture(); setup(f); await f.invoke("reap", "--json"); assert.equal(f.rows()[0].verdict, "ask"); assert.match(f.rows()[0].reason, new RegExp(reason.replaceAll(".", "\\."))); });
for (const identity of ["detached", "non-git"]) test(`reap tolerates ${identity} cwd lanes without invalid gh probes`, async () => {
  const f = fixture(); f.c.lanes[0].cwd = f.cwd; delete f.c.lanes[0].branch;
  if (identity === "non-git") delete f.c.lanes[0].repo;
  saveConfig(f.root, f.c); f.claim("done");
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => cmd === "git" && identity === "non-git" ? f.result("", 128) : run(cmd, args, opts);
  assert.equal(await f.invoke("reap", "--json"), 0, f.err.join("\n"));
  assert.ok(!f.calls.some(call => call.cmd === "gh"));
  assert.ok(!/toLowerCase|undefined/.test(f.rows()[0].reason));
  assert.equal(f.rows()[0].verdict, identity === "non-git" ? "ask" : "handoff");
});
test("detached cwd handoff snapshots round trip without a fabricated branch", () => {
  const f = fixture(); delete f.c.lanes[0].branch;
  const snapshot = expectedSnapshot({ lane: f.c.lanes[0] } as any, { cwd: f.cwd, git: { head: f.head, paths: [], unpushed: [] } } as any);
  const headings = ["Goal", "Repository", "Worktree", "Branch", "HEAD", "Dirty files", "Issue claims", "Open PRs or candidates", "External work", "Next step", "User constraints", "Open items", "Launch prompt"];
  const path = f.put(join(f.root, "context.md"), headings.map(heading => `## ${heading}\nnone`).join("\n") + `\n## Snapshot\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`);
  validateContext(readContext(path), snapshot);
});
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
  const f = fixture(); f.setReceiver(); quitRunner(f); assert.equal(await f.invoke("reap", "L1", "--apply", "--handoff-to", "L0", "--json"), 0);
  assert.equal(f.rows()[0].verdict, "handoff"); assert.ok(existsSync(join(f.root, ".state/handoffs/L1/handoff.json")));
  assert.ok(!f.calls.some(c => c.args.includes("/quit"))); assert.equal(loadRetired(f), false);
});
function loadRetired(f: ReturnType<typeof fixture>) { return Boolean(JSON.parse(readFileSync(join(f.root, "lanes.json"), "utf8")).lanes[0].retired); }
async function accepted(f: ReturnType<typeof fixture>) { f.setReceiver(); assert.equal(await f.invoke("handoff", "L1", "--to", "L0"), 0); assert.equal(await f.invoke("handoff", "L1", "--accept", "--from", "L0"), 0); }
function quitRunner(f: ReturnType<typeof fixture>, exit = true, mutate?: () => void, context = true) {
  let quitting = false;
  f.ctx.env.TMUX = "test"; f.ctx.which = cmd => cmd === "tmux" ? "/usr/bin/tmux" : undefined; const run = f.ctx.run;
  f.ctx.run = async (cmd, args, opts) => {
    if (cmd === "tmux") f.calls.push({ cmd, args });
    if (cmd === "tmux" && args[0] === "list-panes") { mutate?.(); return f.result("/dev/ttys003 %1\n"); }
    if (cmd === "tmux" && args[0] === "send-keys") {
      const text = args.at(-1)!;
      if (text === "/quit") quitting = true;
      else if (text.includes(".state/handoffs/L1.md") && context) ownContext(f);
      if (exit && quitting && text === "Enter") f.setRunning(false);
      return f.result();
    }
    return run(cmd, args, opts);
  };
}
test("review 1: an unlisted dirty tree is refused and its files and identity survive", async () => {
  const f = fixture(); await accepted(f); f.put(join(f.cwd, "dirty.txt"), "keep me"); f.setDirty(" M dirty.txt");
  // Pack must cover the final dirty state, not an older acceptance.
  await f.invoke("handoff", "L1", "--to", "L0"); await f.invoke("handoff", "L1", "--accept", "--from", "L0");
  const prompt = f.put(join(f.root, "prompts/L1.md"), "brief"); const identity = f.put(join(f.home, ".pi/pi-questions/identities.json"), '{"L1":"s1"}');
  f.put(join(f.root, "messages/status/L1.status"), "ready"); f.put(join(f.root, "messages/L0-to-L1-task-1100.md"), "old", 30);
  await f.invoke("handoff", "L1", "--to", "L0"); await f.invoke("handoff", "L1", "--accept", "--from", "L0");
  quitRunner(f, true, undefined, false); ownContext(f, { paths: [] });
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 2);
  assert.equal(loadRetired(f), false); assert.ok(existsSync(prompt));
  assert.ok(existsSync(join(f.cwd, "dirty.txt"))); assert.equal(readFileSync(identity, "utf8"), '{"L1":"s1"}');
  assert.ok(!f.calls.some(c => c.args.includes("/quit")));
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

function ownContext(f: ReturnType<typeof fixture>, snapshot: Record<string, unknown> = {}) {
  const paths = f.getDirty() ? [f.getDirty().slice(3)] : [];
  const digest = treeDigest({ cwd: f.cwd, paths, status: f.getDirty() ? f.getDirty() + "\0" : "", diff: f.head });
  const fields = ["Goal", "Repository", "Worktree", "Branch", "HEAD", "Dirty files", "Issue claims",
    "Open PRs or candidates", "External work", "Next step", "User constraints", "Open items", "Launch prompt"];
  return f.put(join(f.root, ".state/handoffs/L1.md"), fields.map(h => `## ${h}\n${h} context`).join("\n\n") +
    `\n\n## Snapshot\n\`\`\`json\n${JSON.stringify({ head: f.head, paths, digest, unpushed: [f.head], repo: "example/alpha", worktree: f.cwd, branch: "l1", ...snapshot })}\n\`\`\`\n`, -1 / 60000);
}
test("review 1: handoff records paths, HEAD, unpushed commits and dirty-content drift refuses quit", async () => {
  const f = fixture(); f.put(join(f.cwd, "dirty.txt"), "original"); f.setDirty(" M dirty.txt"); await accepted(f);
  const pack = JSON.parse(readFileSync(join(f.root, ".state/handoffs/L1/handoff.json"), "utf8"));
  assert.deepEqual(pack.signals.git.paths, ["dirty.txt"]); assert.deepEqual(pack.signals.git.unpushed, [f.head]);
  assert.equal(pack.signals.git.head, f.head);
  quitRunner(f, true, () => f.put(join(f.cwd, "dirty.txt"), "changed"));
  await f.invoke("reap", "L1", "--apply", "--json"); assert.equal(loadRetired(f), false);
  assert.ok(!f.calls.some(c => c.args.includes("/quit")));
});
test("review 2: absent, stale, incomplete or wrong-SHA own context prevents quit", async () => {
  for (const mode of ["absent", "stale", "incomplete", "wrong-sha"]) {
    const f = fixture(); await accepted(f); quitRunner(f, true, undefined, false);
    if (mode === "stale") { const p = ownContext(f); const old = new Date(f.now.getTime() - 60000); utimesSync(p, old, old); }
    if (mode === "incomplete") f.put(join(f.root, ".state/handoffs/L1.md"), "## Goal\nonly goal", -1 / 60000);
    if (mode === "wrong-sha") ownContext(f, { head: "b".repeat(40) });
    await f.invoke("reap", "L1", "--apply", "--json"); assert.equal(f.rows()[0].verdict, "ask", mode);
    assert.equal(loadRetired(f), false); assert.ok(!f.calls.some(c => c.args.includes("/quit")));
  }
});
async function retired(f: ReturnType<typeof fixture>) {
  await accepted(f); quitRunner(f); assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 0);
  assert.equal(loadRetired(f), true);
}
test("round 2: reap-resume round trip launches the handoff in the preserved worktree", async () => {
  const f = fixture(); await retired(f); f.ctx.env.TMUX = undefined;
  assert.equal(await f.invoke("resume", "L1"), 0);
  const launch = f.out.at(-1)!; assert.ok(launch.includes(`@${join(f.root, ".state/handoffs/L1.md")}`)); assert.ok(launch.includes(f.cwd));
  assert.equal(loadRetired(f), false);
  assert.equal(await f.invoke("start", "L1", "--from-handoff", join(f.root, ".state/handoffs/L1.md")), 0);
});
test("review 4: closure appends audit, STATE and paused claims and notifies the parent", async () => {
  const f = fixture(); f.claim("in-progress", "ready for takeover"); await retired(f);
  const record = JSON.parse(readFileSync(join(f.root, ".state/reaped.log"), "utf8").trim());
  assert.equal(record.id, "L1"); assert.equal(record.ground, "takeover"); assert.equal(record.sha, f.head);
  assert.equal(record.verdict, "retire"); assert.equal(record.sessionFile, f.sessionFile);
  assert.match(record.handoff, /L1\.md$/); assert.equal(record.ts, f.now.toISOString());
  assert.match(readFileSync(join(f.root, "coordinator/STATE.md"), "utf8"), /L1.*takeover.*L1\.md/);
  const events = readFileSync(join(f.ctx.piAgentDir, "issue-work/registry.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(events.at(-1).state, "paused"); assert.match(events.at(-1).note, /handoffs\/L1\.md/);
  assert.ok(readdirSync(join(f.root, "messages")).some(n => /to-L0-lane-closed/.test(n)));
  assert.ok(!readdirSync(join(f.root, "messages")).some(n => /to-ALL-lane-retired/.test(n)));
});
test("review 5: explicit caller and caller-parent protections return keep", async () => {
  const f = fixture(); f.ctx.env.PI_ORCH_ID = "L1";
  await f.invoke("reap", "L1", "--json"); assert.equal(f.rows()[0].verdict, "keep"); assert.match(f.rows()[0].reason, /^caller$/);
  f.c.lanes.push({ ...f.c.lanes[0], id: "L2", worktree: "l2", parent: "L1" }); saveConfig(f.root, f.c);
  f.ctx.env.PI_ORCH_ID = "L2"; await f.invoke("reap", "L1", "--json");
  assert.equal(f.rows()[0].verdict, "keep"); assert.match(f.rows()[0].reason, /^caller's parent$/);
});
test("review minor: acceptance identity and 75-minute fallback", async () => {
  const f = fixture(); f.setReceiver(); await f.invoke("handoff", "L1", "--to", "L0");
  f.ctx.env.PI_ORCH_ID = "L1"; assert.equal(await f.invoke("handoff", "L1", "--accept", "--from", "L0"), 2);
  f.ctx.env.PI_ORCH_ID = undefined; delete f.c.idle; saveConfig(f.root, f.c); f.put(f.sessionFile, "{}", 80);
  await f.invoke("reap", "L1", "--json"); assert.equal(f.rows()[0].verdict, "handoff");
});
test("review 1: explicitly accounted dirty paths may retire without removing their contents", async () => {
  const f = fixture(); f.put(join(f.cwd, "dirty.txt"), "preserve"); f.setDirty(" M dirty.txt"); await retired(f);
  assert.equal(readFileSync(join(f.cwd, "dirty.txt"), "utf8"), "preserve");
  assert.ok(existsSync(f.sessionFile));
});
test("review 2: a handoff-induced session write defers retirement and is reusable only when idle", async () => {
  const f = fixture(); await accepted(f); quitRunner(f);
  const run = f.ctx.run; let wrote = false;
  f.ctx.run = async (cmd, args, options) => {
    const result = await run(cmd, args, options);
    if (!wrote && args.at(-1)?.includes("Write your own context handoff")) {
      wrote = true; f.put(f.sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "handoff response" } }));
    }
    return result;
  };
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 2); assert.equal(loadRetired(f), false);
  assert.match(f.rows()[0].reason, /wait until idle/);
  f.now.setTime(f.now.getTime() + 76 * 60000);
  await f.invoke("handoff", "L1", "--to", "L0"); await f.invoke("handoff", "L1", "--accept", "--from", "L0");
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 0); assert.equal(loadRetired(f), true);
  assert.equal(f.calls.filter(c => c.args.at(-1)?.includes("Write your own context handoff")).length, 1);
});
test("review 2: a validated handoff cannot be replaced just before quit", async () => {
  const f = fixture(); await accepted(f); let lookups = 0;
  quitRunner(f, true, () => { if (++lookups === 2) ownContext(f, { head: "b".repeat(40) }); });
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 2); assert.equal(loadRetired(f), false);
  assert.ok(!f.calls.some(c => c.args.includes("/quit")));
});
test("round 2: start NEW from a handoff and refuse a missing file or changed HEAD", async () => {
  const f = fixture(); await retired(f); f.ctx.env.TMUX = undefined;
  assert.equal(await f.invoke("start", "L2", "--terminal", "print", "--from-handoff", "L1"), 0);
  assert.ok(f.out.at(-1)!.includes(`@${join(f.root, ".state/handoffs/L1.md")}`));
  assert.ok(f.out.at(-1)!.includes("PI_ORCH_ID=L2")); assert.ok(f.out.at(-1)!.includes(f.cwd));
  const g = fixture(); assert.equal(await g.invoke("resume", "L1", "--terminal", "print"), 1);
  ownContext(g, { head: "b".repeat(40) });
  assert.equal(await g.invoke("resume", "L1", "--terminal", "print"), 1); assert.match(g.err.at(-1)!, /HEAD changed/);
});
test("review 4: failed quit never pauses claims or emits audit/STATE/closed events", async () => {
  const f = fixture(); f.claim("blocked", "ready for takeover"); await accepted(f); quitRunner(f, false);
  const before = readFileSync(join(f.ctx.piAgentDir, "issue-work/registry.jsonl"), "utf8");
  await f.invoke("reap", "L1", "--apply", "--json");
  assert.equal(readFileSync(join(f.ctx.piAgentDir, "issue-work/registry.jsonl"), "utf8"), before);
  assert.equal(existsSync(join(f.root, ".state/reaped.log")), false);
  assert.equal(existsSync(join(f.root, "coordinator/STATE.md")), false);
  assert.ok(!readdirSync(join(f.root, "messages")).some(n => n.includes("lane-closed")));
});
test("review minor: children precede their parent even when config lists the parent first", async () => {
  const f = fixture(); f.c.lanes[0].role = "repo-orch";
  f.c.lanes.push({ ...f.c.lanes[0], id: "L2", role: "lane", worktree: "l2", parent: "L1" }); saveConfig(f.root, f.c);
  await f.invoke("reap", "--json"); assert.deepEqual(f.rows().map(row => row.id), ["L2", "L1"]);
});

test("round 2: receipt survives trailing session writes and rotation but still waits for idle", async () => {
  const f = fixture(); f.setReceiver(); quitRunner(f);
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 0);
  const receiptPath = join(f.root, ".state/handoffs/L1.request.json");
  const receipt = readFileSync(receiptPath, "utf8");
  // The native turn keeps writing after ownContext has returned and saved its receipt.
  f.now.setTime(f.now.getTime() + 1000); f.put(f.sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "trailing response" } }));
  f.now.setTime(f.now.getTime() + 1000);
  const continued = f.put(join(dirname(f.sessionFile), "s1-continued.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", content: "turn complete" } }));
  const lease = JSON.parse(readFileSync(f.lease, "utf8")); lease.sessionFile = continued; f.put(f.lease, JSON.stringify(lease));
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 0);
  assert.equal(f.rows()[0].verdict, "keep"); assert.ok(!f.calls.some(c => c.args.includes("/quit")));
  f.now.setTime(f.now.getTime() + 76 * 60000); await accepted(f);
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 0); assert.equal(loadRetired(f), true);
  assert.equal(f.calls.filter(c => c.args.at(-1)?.includes("Write your own context handoff")).length, 1);
  assert.equal(readFileSync(receiptPath, "utf8"), receipt);
});
for (const drift of ["content", "claims"]) test(`round 2: receipt refuses genuine ${drift} drift`, async () => {
  const f = fixture(); f.setReceiver(); f.put(join(f.cwd, "dirty.txt"), "original"); f.setDirty(" M dirty.txt");
  f.claim("blocked", "original takeover"); quitRunner(f);
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 0);
  f.now.setTime(f.now.getTime() + 1000);
  if (drift === "content") f.put(join(f.cwd, "dirty.txt"), "changed"); else f.claim("blocked", "changed takeover");
  await accepted(f); quitRunner(f, true, undefined, false);
  // Suppress the original terminal's automatic reply too: no new context is available.
  const run = f.ctx.run; f.ctx.run = async (cmd, args, opts) =>
    cmd === "tmux" && args.at(-1)?.includes("Write your own context handoff") ? f.result() : run(cmd, args, opts);
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 2);
  assert.equal(loadRetired(f), false); assert.ok(!f.calls.some(c => c.args.includes("/quit")));
});
for (const drift of ["paths", "digest"]) test(`round 2: resume warns and continues on dirty ${drift} drift`, async () => {
  const f = fixture(); f.put(join(f.cwd, "dirty.txt"), "original"); f.setDirty(" M dirty.txt"); await retired(f);
  const path = join(f.cwd, drift === "paths" ? "other.txt" : "dirty.txt"); f.put(path, "changed");
  if (drift === "paths") f.setDirty("?? other.txt");
  f.ctx.env.TMUX = undefined;
  assert.equal(await f.invoke("resume", "L1"), 0);
  assert.match(f.err.join("\n"), new RegExp(`warn.*dirty.*${drift}`, "i"));
  assert.ok(f.out.at(-1)!.includes(`@${join(f.root, ".state/handoffs/L1.md")}`));
  assert.ok(f.out.at(-1)!.includes(f.cwd)); assert.equal(readFileSync(path, "utf8"), "changed");
});
test("round 2: claim pause failure after exit is audited without leaving a half retirement", async () => {
  const f = fixture(); f.claim("blocked", "ready for takeover"); await accepted(f);
  const prompt = f.put(join(f.root, "prompts/L1.md"), "brief"); quitRunner(f);
  const run = f.ctx.run; f.ctx.run = async (cmd, args, opts) => {
    const result = await run(cmd, args, opts);
    const exitProbe = cmd === "ps" && args.join(" ") === "-p 101";
    if (exitProbe && result.code === 1)
      f.put(join(f.ctx.piAgentDir, "issue-work/registry.jsonl"), "{partial registry write");
    return result;
  };
  assert.equal(await f.invoke("reap", "L1", "--apply", "--json"), 0); assert.equal(loadRetired(f), true);
  const record = JSON.parse(readFileSync(join(f.root, ".state/reaped.log"), "utf8").trim());
  assert.match(record.claimPauseError, /registry/i); assert.match(f.err.join("\n"), /L1.*pause claims.*registry/i);
  assert.ok(!existsSync(prompt)); assert.ok(existsSync(join(record.archive, "prompts/L1.md")));
  assert.ok(existsSync(join(record.archive, "closure.json"))); assert.ok(existsSync(record.handoff));
});
