import assert from "node:assert/strict";
import { test } from "node:test";
import { expandNotification, NOTIFY_PREVIEW, TRUNCATION_MARKER } from "./subagent-notify.ts";

const note = (id: string, result: string, extra = "") =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<result>${result}</result>\n<usage>u${extra}</usage>\n</task-notification>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lookupOf = (records: Record<string, { status?: string; result?: string }>) => (id: string) => records[id];

test("short report is expanded whole and marker is gone", () => {
  const full = "a".repeat(1200);
  const out = expandNotification(note("a1", esc("a".repeat(500) + TRUNCATION_MARKER)), lookupOf({ a1: { status: "completed", result: full } }));
  assert.equal(out, note("a1", full));
});

test("long report is cut at the limit with the marker", () => {
  const full = "b".repeat(3000);
  const out = expandNotification(note("a1", "b".repeat(500) + TRUNCATION_MARKER), lookupOf({ a1: { status: "completed", result: full } }));
  assert.equal(out, note("a1", "b".repeat(NOTIFY_PREVIEW) + TRUNCATION_MARKER));
});

test("prefix mismatch, unknown id and running agents stay untouched", () => {
  const input = note("a1", "c".repeat(500) + TRUNCATION_MARKER);
  assert.equal(expandNotification(input, lookupOf({ a1: { status: "completed", result: "x".repeat(900) } })), input);
  assert.equal(expandNotification(input, lookupOf({})), input);
  assert.equal(expandNotification(input, lookupOf({ a1: { status: "running", result: "c".repeat(900) } })), input);
  assert.equal(expandNotification(input, () => { throw new Error("boom"); }), input);
});

test("special characters round-trip through escaping", () => {
  const full = "<a> & b ".repeat(100);
  const preview = full.slice(0, 40);
  const out = expandNotification(note("a1", esc(preview) + TRUNCATION_MARKER), lookupOf({ a1: { status: "completed", result: full } }));
  assert.equal(out, note("a1", esc(full)));
});

test("non-truncated notification is untouched", () => {
  const input = note("a1", "done");
  assert.equal(expandNotification(input, lookupOf({ a1: { status: "completed", result: "done and more" } })), input);
});

test("grouped notifications are each expanded", () => {
  const a = "a".repeat(300), b = "b".repeat(300);
  const input = note("a1", a + TRUNCATION_MARKER) + "\n" + note("b1", b + TRUNCATION_MARKER);
  const out = expandNotification(input, lookupOf({ a1: { status: "completed", result: a + "A" }, b1: { status: "error", result: b + "B" } }));
  assert.equal(out, note("a1", a + "A") + "\n" + note("b1", b + "B"));
});
