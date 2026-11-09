import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, REPO } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";
import { ownershipOf, foldRegistry, sessionLiveness } from "../src/lanes/issue-register.ts";
import { ownershipOf as originalOwnership } from "../../agent/lib/issue-work-register.ts";
import { foldRegistry as originalFold, sessionLiveness as originalLiveness } from "../../agent/lib/issue-work.ts";

function fixture() {
  const home = tempDir("lanes-send-owner"); const lines: string[] = []; const errors: string[] = [];
  const now = new Date("2026-01-20T12:00:00Z");
  const ctx: LanesCtx = { home, cwd: home, env: { PI_ORCH_ID: "C0" }, platform: "linux", now: () => now,
    run: async (name, args) => ({ code: 0, stdout: name === "pgrep" ? "701" : args.includes("lstart=") ? "synthetic start" : "701", stderr: "", timedOut: false }),
    readCwd: async () => join(home, "owner"), realpath: p => p, which: () => undefined,
    out: s => lines.push(s), err: s => errors.push(s), stdinTTY: true, readStdin: async () => { throw new Error("must not read body"); },
    templatesDir: join(REPO, "installer/lanes/templates"), piAgentDir: join(home, "agent"), loadModule: async () => ({}) };
  const c = defaults(home, home); c.coordinator.id = "C0";
  for (const [id, path] of [["OWNER1", "owner"], ["OTHER1", "other"]]) {
    mkdirSync(join(home, path)); c.lanes.push({ id, repo: "example/alpha", worktree: path, cwd: join(home, path), branch: `synthetic-${path}`, group: null, prompt: "prompt.md" });
  }
  saveConfig(home, c);
  const put = (path: string, value: unknown) => { const full = join(ctx.piAgentDir, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, typeof value === "string" ? value : JSON.stringify(value)); };
  const event = { ts: now.toISOString(), repo: "example/alpha", issue: 42, state: "in-progress", sessionId: "session-owner", source: "tool", branch: "owned-branch" };
  const registry = (fields = {}) => put("issue-work/registry.jsonl", JSON.stringify({ ...event, ...fields }));
  const lease = () => put("issue-work/sessions/owner.json", { sessionId: event.sessionId, pid: 701, startedAt: event.ts, procStart: "synthetic start", cwd: join(home, "owner") });
  const send = (to = "OTHER1", ...args: string[]) => main(["send", to, "task", "-m", "synthetic body", "--issue", "42", ...args], ctx);
  const messages = () => { try { return readdirSync(join(home, "messages")).filter(n => n.endsWith(".md")); } catch { return []; } };
  return { home, ctx, c, now, lines, errors, event, registry, lease, send, messages };
}

test("duplicate issue assignment refuses before reading or writing a body; holder is allowed", async () => {
  const f = fixture(); f.registry(); f.lease();
  assert.equal(await main(["send", "OTHER1", "task", "-", "--issue", "42"], f.ctx), 3);
  assert.equal(f.messages().length, 0); assert.match(f.errors.join(" "), /session-owner/);
  assert.match(f.errors.join(" "), /owned-branch/); assert.match(f.errors.join(" "), /--force/);
  assert.equal(await f.send("OWNER1"), 0);
});
test("recent ended delivery refuses; old done is free", async () => {
  const f = fixture(); f.registry({ state: "in-review", ts: "2026-01-18T12:00:00Z" });
  assert.equal(await f.send(), 3); assert.equal(f.messages().length, 0);
  f.registry({ state: "done", ts: "2026-01-01T12:00:00Z" }); assert.equal(await f.send(), 0);
});
test("unknown holder liveness refuses; a force reason is visible in the body", async () => {
  const f = fixture(); f.registry(); f.lease();
  f.ctx.run = async (name) => ({ code: name === "ps" ? 0 : 1, stdout: "", stderr: "", timedOut: false });
  assert.equal(await f.send(), 3);
  assert.equal(await f.send("OTHER1", "--force", "verified reassignment"), 0);
  assert.equal(readFileSync(f.lines.at(-1)!, "utf8"), "Ownership override (--force): verified reassignment\n\nsynthetic body");
  assert.match(f.errors.at(-1)!, /verified reassignment/);
});
test("invalid force, ambiguous repo and broadcast issue sends are usage errors", async () => {
  const f = fixture();
  assert.equal(await main(["send", "OTHER1", "task", "-m", "body", "--force", "reason"], f.ctx), 2);
  assert.equal(await f.send("OTHER1", "--force", " "), 2);
  assert.equal(await f.send("UNKNOWN1"), 2); assert.match(f.errors.at(-1)!, /issue needs a repo: use OWNER\/REPO#N/);
  for (const to of ["ALL", "BCAST"]) assert.equal(await main(["send", to, "task", "-m", "body", "--issue", "example/alpha#42"], f.ctx), 2);
  f.c.lanes[0].group = "GROUP1"; saveConfig(f.home, f.c);
  assert.equal(await main(["send", "GROUP1", "task", "-m", "body", "--issue", "example/alpha#42"], f.ctx), 2);
});
test("missing register allows with a note; unreadable register refuses", async () => {
  const f = fixture(); assert.equal(await f.send(), 0); assert.match(f.errors.join(" "), /issue register not found/);
  mkdirSync(join(f.ctx.piAgentDir, "issue-work/registry.jsonl"), { recursive: true });
  assert.equal(await f.send(), 3); assert.match(f.errors.at(-1)!, /ownership unavailable:/);
});
test("every live session for a recipient counts, not only its newest lease", async () => {
  const f = fixture(); f.registry(); f.lease();
  const dir = join(f.ctx.piAgentDir, "issue-work/sessions");
  writeFileSync(join(dir, "second.json"), JSON.stringify({ sessionId: "session-second", pid: 702, startedAt: "2026-01-20T12:01:00Z", procStart: "synthetic start", cwd: join(f.home, "owner") }));
  f.ctx.run = async (name, args) => ({ code: 0, stdout: name === "pgrep" ? "701\n702" : args.includes("lstart=") ? "synthetic start" : "701", stderr: "", timedOut: false });
  assert.equal(await f.send("OWNER1"), 0);
});
test("PID reuse and failed lease probing cannot allow duplicate assignment", async () => {
  const f = fixture(); f.registry(); f.lease();
  f.ctx.run = async (name, args) => ({ code: 0, stdout: name === "pgrep" ? "701" : args.includes("lstart=") ? "reused process" : "701", stderr: "", timedOut: false });
  assert.equal(await f.send("OWNER1"), 3); assert.equal(f.messages().length, 0);
  f.ctx.run = async () => { throw new Error("synthetic ps failure"); };
  assert.equal(await f.send("OWNER1"), 3);
});
test("full issue selects a repo without inference; #N infers the concrete lane", async () => {
  const f = fixture();
  assert.equal(await main(["send", "UNKNOWN1", "task", "-m", "body", "--issue", "example/alpha#42"], f.ctx), 0);
  assert.equal(await main(["send", "OTHER1", "task", "-m", "body", "--issue", "#42"], f.ctx), 0);
});
test("send without issue preserves the body and does not read ownership", async () => {
  const f = fixture(); mkdirSync(join(f.ctx.piAgentDir, "issue-work/registry.jsonl"), { recursive: true });
  assert.equal(await main(["send", "OTHER1", "task", "-m", "unchanged\nbody"], f.ctx), 0);
  assert.equal(readFileSync(f.lines.at(-1)!, "utf8"), "unchanged\nbody"); assert.deepEqual(f.errors, []);
});
test("lease liveness port preserves unknown starts, PID reuse and newest-per-PID precedence", () => {
  const base = { sessionId: "session-one", pid: 701, startedAt: "2026-01-20T12:00:00Z", procStart: "synthetic start" };
  for (const leases of [[base], [{ ...base, procStart: undefined }], [base, { ...base, sessionId: "session-two", startedAt: "2026-01-20T12:01:00Z" }]]) {
    for (const current of [undefined, "synthetic start", "reused start"]) for (const alive of [false, true]) {
      assert.deepEqual(sessionLiveness(leases, () => alive, () => current), originalLiveness(leases, () => alive, () => current));
    }
  }
});
test("installer ownership verdicts stay in parity with agent register policy", () => {
  const now = new Date("2026-01-20T12:00:00Z");
  const base = { repo: "example/alpha", issue: 42, sessionId: "session-synthetic", source: "tool" as const, ts: "2026-01-18T12:00:00Z" };
  const fixtures = [[], [{ ...base, state: "in-progress" as const }], [{ ...base, state: "in-review" as const }],
    [{ ...base, state: "done" as const, ts: "2026-01-01T12:00:00Z" }], [{ ...base, state: "paused" as const, ts: now.toISOString() }],
    [{ ...base, state: "blocked" as const }], [{ ...base, note: "delivered implementation" }], [{ ...base, note: "not delivered" }]];
  for (const events of fixtures) for (const status of ["live", "unknown", "ended"] as const) {
    const liveness = new Map(status === "ended" ? [] : [[base.sessionId, { status, pid: 701 }]]);
    const args = { events, liveness, now };
    assert.equal(ownershipOf({ ...args, view: foldRegistry(events).get("example/alpha#42") }).verdict,
      originalOwnership({ ...args, view: originalFold(events).get("example/alpha#42") }).verdict);
  }
});
