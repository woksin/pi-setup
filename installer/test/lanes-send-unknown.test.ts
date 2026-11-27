import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tempDir } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";

function fixture() {
  const home = tempDir("lanes-send-unknown"); const lines: string[] = []; const errors: string[] = [];
  const cwds = new Map<number, string>();
  const ctx: LanesCtx = { home, cwd: home, env: { PI_ORCH_ID: "C0" }, platform: "linux", now: () => new Date("2026-01-20T12:00:00Z"),
    run: async () => ({ code: 0, stdout: [...cwds.keys()].map(pid => `${pid} pi`).join("\n"), stderr: "", timedOut: false }),
    readCwd: async pid => cwds.get(pid), realpath: p => p, pidAlive: pid => cwds.has(pid), which: () => undefined,
    out: s => lines.push(s), err: s => errors.push(s), stdinTTY: true, readStdin: async () => "",
    templatesDir: home, piAgentDir: join(home, "agent"), loadModule: async () => ({}) };
  const c = defaults(home, home); c.coordinator.id = "C0"; c.messages.broadcast = "BCAST"; saveConfig(home, c);
  const registration = (id: string, pid: number, fields = {}) => {
    const cwd = join(home, id); cwds.set(pid, cwd); mkdirSync(join(home, ".state/roster"), { recursive: true });
    writeFileSync(join(home, `.state/roster/${pid}.json`), JSON.stringify({ id, pid, cwd, startedAt: ctx.now().toISOString(), ...fields }));
  };
  const send = (to = "L7") => main(["send", to, "task", "-m", "body"], ctx);
  return { home, ctx, c, cwds, errors, lines, registration, send };
}
test("unknown recipient warns with at most three ranked live candidates and still writes", async () => {
  const f = fixture(); f.registration("L70", 20); f.registration("L71", 21); f.registration("L8", 22); f.registration("Z9", 23);
  assert.equal(await f.send(), 0); assert.equal(readFileSync(f.lines.at(-1)!, "utf8"), "body");
  const warning = f.errors.join("\n"); assert.match(warning, /warning: unknown recipient L7/);
  assert.match(warning, /closest live: L70 \[launched\] - idle, L71 \[launched\] - idle, L8 \[launched\] - idle/);
  assert.doesNotMatch(warning, /Z9/);
});
test("edit distance precedes idle preference after shared prefix", async () => {
  const f = fixture(); f.registration("L72", 20); f.registration("L73", 21); f.registration("L700", 22);
  const status = join(f.home, "messages/status"); mkdirSync(status, { recursive: true }); writeFileSync(join(status, "L72.status"), "working");
  assert.equal(await f.send(), 0); const warning = f.errors.join("\n");
  assert.ok(warning.indexOf("L73 [launched]") < warning.indexOf("L72 [launched]"));
  assert.ok(warning.indexOf("L72 [launched]") < warning.indexOf("L700 [launched]"));
});
test("candidate similarity is case-insensitive", async () => {
  const f = fixture(); f.registration("L7Az", 20); f.registration("L7B", 21); f.registration("L7AAA", 22);
  assert.equal(await f.send("L7AZZ"), 0); const warning = f.errors.join("\n");
  assert.ok(warning.indexOf("L7Az [launched]") < warning.indexOf("L7AAA [launched]"));
  assert.ok(warning.indexOf("L7AAA [launched]") < warning.indexOf("L7B [launched]"));
});
for (const to of ["S01abc12", "S01ABC12", "s01ABC12"]) test(`live registration outside config resolves ${to} without warnings`, async () => {
  const f = fixture(); f.registration("S01abc12", 20);
  f.ctx.run = async () => ({ code: 1, stdout: "", stderr: "unavailable", timedOut: false });
  assert.equal(await f.send(to), 0); assert.deepEqual(f.errors, []);
  assert.match(basename(f.lines.at(-1)!), /^C0-to-S01abc12-task-/);
});
for (const to of ["L7A", "l7a"]) test(`live case collision refuses ${to} without writing a message`, async () => {
  const f = fixture(); f.registration("L7a", 20); f.registration("L7A", 21);
  assert.equal(await f.send(to), 2);
  assert.ok(f.errors.some(error => error.includes("L7A") && error.includes("L7a")));
  assert.ok(!existsSync(join(f.home, "messages")));
});
for (const mode of ["dead", "retired", "unknown"]) test(`no live candidates: ${mode} keeps the warning only`, async () => {
  const f = fixture();
  if (mode !== "unknown") { f.registration("L7", 20, mode === "retired" ? { retiredAt: f.ctx.now().toISOString() } : {}); f.cwds.clear(); }
  assert.equal(await f.send(), 0); assert.match(f.errors.join("\n"), /warning: unknown recipient L7/); assert.doesNotMatch(f.errors.join("\n"), /closest live:/);
});
test("roster failures cannot prevent an unknown-recipient message", async () => {
  const f = fixture();
  // The file backend also needs now; fail only the first roster clock read.
  let calls = 0; f.ctx.now = () => { if (++calls === 1) throw new Error("roster unavailable"); return new Date("2026-01-20T12:00:00Z"); };
  assert.equal(await f.send(), 0); assert.match(f.errors.join("\n"), /warning: unknown recipient L7/); assert.equal(readFileSync(f.lines.at(-1)!, "utf8"), "body");
});
for (const to of ["ALL", "BCAST", "GROUP1", "L1", "l1"]) test(`configured or broadcast target ${to} sends without warning`, async () => {
  const f = fixture(); f.c.lanes.push({ id: "L1", repo: "example/repo", worktree: "lane", branch: "lane", group: "GROUP1", prompt: "prompt.md" }); saveConfig(f.home, f.c);
  assert.equal(await f.send(to), 0); assert.deepEqual(f.errors, []);
  assert.ok(basename(f.lines.at(-1)!).startsWith(`C0-to-${to.toUpperCase()}-task-`));
});
