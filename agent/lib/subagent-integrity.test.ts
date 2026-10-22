import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateExitInText, hasHedge, integrityWarnings, isFailedStatus, lastGateExit, parseNotifications, readLastGateExit, readTail } from "./subagent-integrity.ts";
import { ResultTracker } from "../extensions/subagent-result-guard.ts";

const tool = (text: string, toolName = "bash") => JSON.stringify({ type: "message", message: { role: "toolResult", toolName, content: [{ type: "text", text }] } });
const note = (status: string, result: string) =>
  `<task-notification>\n<task-id>a1</task-id>\n<status>${status}</status>\n<result>${result}</result>\n</task-notification>`;

test("parseNotifications decodes status and result", () => {
  const [n] = parseNotifications(note("Error: 429 &lt;rate&gt;", "No output."));
  assert.deepEqual(n, { id: "a1", status: "Error: 429 <rate>", result: "No output." });
});

test("failed statuses", () => {
  for (const s of ["Error: x", "Aborted (max turns exceeded)", "Stopped"]) assert.ok(isFailedStatus(s), s);
  for (const s of ["Done", "Wrapped up (turn limit)"]) assert.ok(!isFailedStatus(s), s);
});

test("gate exit from log and finished lines", () => {
  assert.deepEqual(gateExitInText("x\npi-phase: log=/r/.ai-work/t/build.log exit=1 lines=9"), { label: "build.log", exit: 1 });
  assert.deepEqual(gateExitInText("pi-phase: finished kind=build label=Tier1 Release exit=2"), { label: "Tier1 Release", exit: 2 });
  assert.equal(gateExitInText("nothing"), undefined);
});

test("last gate exit wins; ignores non-bash and malformed lines", () => {
  const jsonl = [
    tool("pi-phase: finished kind=build label=A exit=1"),
    "not json exit=5",
    tool("pi-phase: finished kind=test label=B exit=0"),
    tool("pi-phase: finished kind=test label=C exit=7", "read"),
  ].join("\n");
  assert.deepEqual(lastGateExit(jsonl), { label: "B", exit: 0 });
  assert.equal(lastGateExit(tool("hello")), undefined);
});

test("hedges", () => {
  assert.ok(hasHedge("Build failed, not done"));
  assert.ok(hasHedge("Gate waived by parent"));
  assert.ok(!hasHedge("All done; tests pass."));
});

test("warnings: error status is not a completion", () => {
  const [w] = integrityWarnings({ id: "a1", status: "Error: boom", result: "x" }, undefined);
  assert.match(w, /NOT a completion/);
});

test("warnings: non-zero gate without hedge warns; with hedge or exit 0 does not", () => {
  const rec = { sessionFile: "/f" };
  const fail = () => ({ exit: 1, label: "Tier1" });
  const [w] = integrityWarnings({ id: "a1", status: "Done", result: "Finished, all good" }, rec, fail);
  assert.equal(w, "subagent a1: last gate exit=1 (Tier1); treat as NOT done unless waived");
  assert.deepEqual(integrityWarnings({ id: "a1", status: "Done", result: "Tier 1 failed, unverified" }, rec, fail), []);
  assert.deepEqual(integrityWarnings({ id: "a1", status: "Done", result: "ok" }, rec, () => ({ exit: 0, label: "x" })), []);
  assert.deepEqual(integrityWarnings({ id: "a1", status: "Done", result: "ok" }, undefined, fail), []);
});

test("unrelated log=… exit=… output does not count as a gate", () => {
  const jsonl = [
    tool("pi-phase: finished kind=build label=Tier1 exit=1"),
    tool("report: log=/tmp/report.log exit=0 lines=2"),
    tool("echo log=/tmp/x.log exit=0 lines=2"),
  ].join("\n");
  assert.deepEqual(lastGateExit(jsonl), { label: "Tier1", exit: 1 });
  assert.equal(gateExitInText("x log=/a exit=0 lines=1"), undefined);
});

test("more hedges", () => {
  for (const r of ["Verification exit=124; awaiting follow-up", "tests pending", "integration not run"]) assert.ok(hasHedge(r), r);
});

test("readTail bounds the read and drops the partial first line", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-"));
  const file = join(dir, "s.jsonl");
  const old = tool("pi-phase: finished kind=build label=Old exit=9");
  const last = tool("pi-phase: finished kind=build label=New exit=1");
  writeFileSync(file, `${old}\n${"x".repeat(5000)}\n${last}\n`);
  const text = readTail(file, 200);
  assert.ok(!text.includes("Old"));
  assert.deepEqual(lastGateExit(text), { label: "New", exit: 1 });
  assert.deepEqual(readLastGateExit(file), { label: "New", exit: 1 });
  assert.equal(readLastGateExit(join(dir, "missing")), undefined);
});

test("reload replay does not re-warn; a fresh notification afterwards does", () => {
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] = undefined;
  const msg = (id: string, status: string) => ({ role: "custom", customType: "subagent-notification", timestamp: Math.random(),
    content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<result>No output.</result>\n</task-notification>` });
  const t = new ResultTracker();
  const seen: string[] = [];
  t.onFresh = (n, r) => seen.push(...integrityWarnings(n, r));
  t.replay(() => t.notification(msg("old", "Error: boom")));
  assert.deepEqual(seen, []);
  t.notification(msg("old", "Error: boom")); // same id already delivered by replay
  assert.deepEqual(seen, []);
  t.notification(msg("new", "Error: boom"));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /subagent new/);
});
