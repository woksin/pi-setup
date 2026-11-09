import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { tempDir } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";
import { classifyUnacked } from "../src/lanes/commands/unacked.ts";
import type { MessageRef } from "../src/lanes/backend.ts";

function fixture() {
  const home = tempDir("lanes-unacked"); const lines: string[] = []; const errors: string[] = [];
  const now = new Date("2026-01-20T12:00:00Z");
  const ctx: LanesCtx = { home, cwd: home, env: {}, platform: "linux", now: () => now,
    run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), which: () => undefined,
    realpath: p => p, out: s => lines.push(s), err: s => errors.push(s), stdinTTY: true, readStdin: async () => "",
    templatesDir: home, piAgentDir: join(home, "agent"), loadModule: async () => ({}) };
  const c = defaults(home, home); c.messages.broadcast = "EVERYONE";
  c.lanes.push(...["L1", "L2", "R-FOO"].map(id => ({ id, repo: "example/alpha", worktree: id, branch: id, group: "TEAM", prompt: "prompt.md" })));
  saveConfig(home, c); mkdirSync(join(home, "messages"));
  const put = (name: string, age: number) => { const path = join(home, "messages", name); writeFileSync(path, "test"); const at = new Date(now.getTime() - age * 60000); utimesSync(path, at, at); return name; };
  let serial = 0;
  const message = (from = "L0", to = "L1", age = 60) => put(`${from}-to-${to}-topic-1200-${++serial}.md`, age);
  const marker = (id: string, age: number) => put(`${id}-inbox.marker`, age);
  const unacked = async (...args: string[]) => { lines.length = 0; const code = await main(["unacked", "--json", ...args], ctx); return { code, report: lines.length ? JSON.parse(lines.at(-1)!) : null }; };
  return { home, ctx, c, now, message, marker, put, unacked, lines, errors };
}
for (const markerAge of [undefined, 70, 60, 20]) test(`unacked distinguishes unread from read-only with marker age ${markerAge}`, async () => {
  const f = fixture(); const name = f.message(); if (markerAge !== undefined) f.marker("L1", markerAge);
  const { code, report } = await f.unacked(); assert.equal(code, 0);
  assert.deepEqual(report.rows[0], { name, from: "L0", to: "L1", topic: "topic", ageMin: 60,
    state: markerAge === 20 ? "read-no-reply" : "unread", recipient: { state: "stopped", identity: "registered", pid: null } });
  assert.deepEqual(Object.keys(report), ["at", "minutes", "hours", "rows", "excluded", "sources"]);
  assert.equal(report.minutes, 30); assert.equal(report.hours, 24); assert.deepEqual(report.excluded, { retired: 0 });
});
test("a live recipient with a stuck watch exposes the held-hour redelivery", async () => {
  const f = fixture(); f.message("L0", "L1", 65); f.marker("L1", 70);
  f.ctx.run = async () => ({ code: 0, stdout: "701 pi", stderr: "", timedOut: false }); f.ctx.readCwd = async () => join(f.home, "..", ".worktrees", "L1");
  // A fresh heartbeat and process share the configured worktree.
  mkdirSync(join(f.home, ".pi/orch/heartbeats"), { recursive: true });
  writeFileSync(join(f.home, ".pi/orch/heartbeats/p701.json"), JSON.stringify({ id: "L1", pid: 701, at: f.now.toISOString(), state: "working" }));
  const { report } = await f.unacked(); assert.equal(report.rows[0].state, "unread"); assert.equal(report.rows[0].ageMin, 65);
  assert.equal(report.rows[0].recipient.state, "working"); assert.equal(report.rows[0].recipient.pid, 701);
});
for (const reply of ["later", "earlier", "other", "multi"]) test(`reply acknowledgment: ${reply}`, async () => {
  const f = fixture(); const name = f.message();
  f.message("L1", reply === "other" ? "L2" : reply === "multi" ? "L0-L2" : "L0", reply === "earlier" ? 90 : 10);
  const { report } = await f.unacked();
  assert.equal(report.rows.some((r: any) => r.name === name), !["later", "multi"].includes(reply));
});
test("threshold defaults, config and override apply; empty reports exit 1", async () => {
  const f = fixture(); f.message("L0", "L1", 20); assert.equal((await f.unacked()).code, 1);
  f.c.messages.ackMinutes = 15; saveConfig(f.home, f.c); assert.equal((await f.unacked()).code, 0);
  assert.equal((await f.unacked("--minutes", "25")).code, 1);
  f.c.messages.ackMinutes = 45; saveConfig(f.home, f.c); assert.equal((await f.unacked("--minutes", "5")).code, 0);
});
for (const minutes of ["0", "abc", "1.5", "-1"]) test(`invalid minutes ${minutes} exit 2`, async () => {
  const f = fixture(); assert.equal((await f.unacked("--minutes", minutes)).code, 2); assert.match(f.errors.join("\n"), /minutes/);
});
test("broadcasts, group fan-out, self-sends and messages outside 24 hours are excluded", async () => {
  const f = fixture(); for (const to of ["ALL", "EVERYONE", "BCAST", "TEAM", "L0"]) f.message("L0", to);
  f.put("BCAST-topic-1200.md", 60); f.message("L0", "L1", 24 * 60 + 1);
  assert.equal((await f.unacked()).code, 1);
});
test("multi-recipient expansion preserves known hyphenated IDs and unknown ambiguous IDs", async () => {
  const f = fixture(); f.message("L0", "L1-L2"); f.message("L0", "R-FOO"); f.message("L0", "MYSTERY-ID");
  const { report } = await f.unacked(); assert.deepEqual(report.rows.map((r: any) => r.to).sort(), ["L1", "L2", "MYSTERY-ID", "R-FOO"]);
});
test("recipient splitting backtracks to a complete known-ID decomposition", async () => {
  const f = fixture(); f.c.lanes.push(...["R-A", "R-A-R", "R-B"].map(id => ({ id, repo: "example/alpha", worktree: id, branch: id, group: null, prompt: "prompt.md" })));
  saveConfig(f.home, f.c); f.put("L0-to-R-A-R-B-task-1100.md", 60);
  assert.deepEqual((await f.unacked()).report.rows.map((r: any) => r.to).sort(), ["R-A", "R-B"]);
  f.c.lanes.push({ id: "R-A-R-B", repo: "example/alpha", worktree: "whole", branch: "whole", group: null, prompt: "prompt.md" }); saveConfig(f.home, f.c);
  assert.deepEqual((await f.unacked()).report.rows.map((r: any) => r.to), ["R-A-R-B"]);
});
test("rows are oldest first with stable ties; human output includes recipient liveness", async () => {
  const f = fixture(); f.message("L0", "L1", 40); const oldest = f.message("L0", "L2", 90);
  const { report } = await f.unacked(); assert.equal(report.rows[0].name, oldest);
  f.lines.length = 0; assert.equal(await main(["unacked"], f.ctx), 0);
  assert.match(f.lines.join("\n"), /90m\s+L0->L2 topic unread recipient=stopped/);
});
test("lookback defaults to 24 hours with config and CLI overrides including 14 days", async () => {
  const f = fixture(); f.message("L0", "L1", 25 * 60);
  assert.equal((await f.unacked()).code, 1);
  f.c.messages.ackLookbackHours = 26; saveConfig(f.home, f.c);
  assert.equal((await f.unacked()).report.rows.length, 1);
  assert.equal((await f.unacked("--hours", "24")).code, 1);
  f.message("L0", "L2", 335 * 60); f.message("L0", "R-FOO", 337 * 60);
  const { code, report } = await f.unacked("--hours", "336");
  assert.equal(code, 0); assert.equal(report.hours, 336); assert.equal(report.rows.length, 2);
});
for (const hours of ["0", "abc", "1.5", "-1", "9007199254740992"]) test(`invalid hours ${hours} exit 2`, async () => {
  const f = fixture(); assert.equal((await f.unacked("--hours", hours)).code, 2); assert.match(f.errors.join("\n"), /hours/);
});
for (const closed of [false, true]) test(`retired recipients (${closed ? "closed status" : "config"}) are excluded unless requested`, async () => {
  const f = fixture(); f.message("L0", "L1"); f.message("L0", "L1"); f.message("L0", "L2"); f.message("L0", "UNKNOWN");
  if (closed) { mkdirSync(join(f.home, "messages/status")); writeFileSync(join(f.home, "messages/status/L1.status"), "closed finished"); }
  else { f.c.lanes.find(l => l.id === "L1")!.retired = true; saveConfig(f.home, f.c); }
  const { report } = await f.unacked(); assert.deepEqual(report.excluded, { retired: 2 });
  assert.deepEqual(report.rows.map((r: any) => r.to).sort(), ["L2", "UNKNOWN"]);
  const included = await f.unacked("--include-retired"); assert.equal(included.report.rows.length, 4);
  assert.deepEqual(included.report.excluded, { retired: 0 });
});
test("only retired outstanding messages exits 1 and still reports exclusions", async () => {
  const f = fixture(); f.message(); f.c.lanes.find(l => l.id === "L1")!.retired = true; saveConfig(f.home, f.c);
  const { code, report } = await f.unacked(); assert.equal(code, 1); assert.deepEqual(report.rows, []); assert.deepEqual(report.excluded, { retired: 1 });
});
test("human summaries precede the 20 oldest rows while JSON retains every row", async () => {
  const f = fixture(); f.message("L0", "L2", 120);
  for (let age = 100; age >= 80; age--) f.message("L0", "L1", age);
  f.marker("L1", 90);
  const { report } = await f.unacked(); assert.equal(report.rows.length, 22);
  f.lines.length = 0; assert.equal(await main(["unacked"], f.ctx), 0);
  assert.deepEqual(f.lines.slice(0, 2), [
    "recipient=L2 state=stopped unread=1 read-no-reply=0 oldest=120m",
    "recipient=L1 state=stopped unread=11 read-no-reply=10 oldest=100m",
  ]);
  const messages = f.lines.filter(line => /^\d+m\s/.test(line)); assert.equal(messages.length, 20);
  assert.match(messages[0], /^120m\s+L0->L2/); assert.match(messages.at(-1)!, /^82m\s+L0->L1/);
  assert.ok(f.lines.includes("2 message rows omitted; use --json to see all 22."));
});
test("human summary ties sort by recipient and small reports omit no rows", async () => {
  const f = fixture(); f.message("L0", "L2"); f.message("L0", "L1");
  assert.equal(await main(["unacked"], f.ctx), 0);
  assert.match(f.lines[0], /^recipient=L1 /); assert.match(f.lines[1], /^recipient=L2 /);
  assert.equal(f.lines.filter(line => /omitted/.test(line)).length, 0);
});
test("missing messages and marker I/O errors exit 2 with a diagnostic", async () => {
  const f = fixture(); f.c.messages.dir = "missing"; saveConfig(f.home, f.c);
  assert.equal((await f.unacked()).code, 2); assert.match(f.errors.join("\n"), /messages/);
  f.c.messages.dir = "messages"; saveConfig(f.home, f.c); f.message();
  // A directory marker is not a valid inbox read signal.
  mkdirSync(join(f.home, "messages/L1-inbox.marker")); assert.equal((await f.unacked()).code, 2);
});
test("unacked scans a large file bus once and reads each recipient marker once", async t => {
  const f = fixture(); for (let i = 0; i < 5000; i++) f.put(`L0-to-L1-topic-1200-${i + 1}.md`, 60);
  f.marker("L1", 90); let markers = 0; const originalStat = fs.statSync;
  t.mock.method(fs, "statSync", function (path, ...args) {
    if (String(path).endsWith("-inbox.marker")) markers++;
    return originalStat(path, ...args);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { FileBackend } = await import("../src/lanes/backend.ts");
  const original = FileBackend.prototype.list; let lists = 0;
  t.mock.method(FileBackend.prototype, "list", function (...args) { lists++; return original.apply(this, args); });
  const started = performance.now(); const { code, report } = await f.unacked();
  assert.equal(code, 0); assert.equal(report.rows.length, 5000); assert.equal(lists, 1); assert.equal(markers, 1);
  assert.ok(performance.now() - started < 5000, "5000-file report should finish within five seconds");
});
test("reply indexing classifies 40,000 messages without pairwise scans", () => {
  const now = new Date("2026-01-20T12:00:00Z"); const old = new Date(now.getTime() - 3600000);
  const messages: MessageRef[] = Array.from({ length: 40000 }, (_, i) => ({ name: `L0-to-L1-task-1200-${i}.md`, from: "L0", to: ["L1"], topic: "task", at: old }));
  messages.push({ name: "L1-to-L0-reply-1200.md", from: "L1", to: ["L0"], topic: "reply", at: now });
  const started = performance.now();
  assert.deepEqual(classifyUnacked(messages, new Map(), { rows: [], groups: [], broadcast: "ALL" }, now, 30), []);
  assert.ok(performance.now() - started < 5000, "40,000 messages should not require quadratic reply searches");
});
