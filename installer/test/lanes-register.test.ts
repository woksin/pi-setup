import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { defaults, saveConfig } from "../src/lanes/config.ts";
import { main } from "../src/lanes/main.ts";

function fixture() {
  const home = tempDir("lanes-register"); const lines: string[] = []; const errors: string[] = [];
  let now = new Date("2026-01-20T12:00:00Z");
  const ctx: LanesCtx = { home, cwd: home, env: {}, platform: "linux", now: () => now,
    run: async (_name, args) => ({ code: 0, stdout: args.includes("pid=,ppid=,comm=")
      ? `${process.pid} 30 bash\n30 20 sh\n20 10 pi\n10 1 pi-session` : "20 pi", stderr: "", timedOut: false }),
    readCwd: async () => home, realpath: realpathSync, pidAlive: () => true, which: () => undefined,
    out: s => lines.push(s), err: s => errors.push(s), stdinTTY: true, readStdin: async () => "",
    templatesDir: home, piAgentDir: join(home, "agent"), loadModule: async () => ({}) };
  const c = defaults(home, home); c.coordinator.cwd = join(home, "coordinator"); saveConfig(home, c);
  const path = join(home, ".state/roster/L9.json");
  const record = () => JSON.parse(readFileSync(path, "utf8"));
  const put = (fields = {}) => { mkdirSync(join(home, ".state/roster"), { recursive: true }); writeFileSync(path, JSON.stringify({ id: "L9", pid: 20, cwd: realpathSync(home), startedAt: now.toISOString(), ...fields })); };
  const invoke = (...args: string[]) => main(args, ctx);
  const who = async () => { assert.equal(await invoke("who", "--json"), 0); return JSON.parse(lines.at(-1)!).rows.find((r: any) => r.lane === "L9"); };
  return { home, ctx, lines, errors, path, record, put, invoke, who, tick: () => { now = new Date(now.getTime() + 60000); } };
}
test("explicit registration canonicalizes cwd and who names a launched live Pi", async () => {
  const f = fixture(); const alias = join(f.home, "alias"); symlinkSync(f.home, alias);
  assert.equal(await f.invoke("register", "L9", "--pid", "20", "--cwd", alias), 0);
  assert.deepEqual(f.record(), { id: "L9", pid: 20, cwd: realpathSync(f.home), startedAt: f.ctx.now().toISOString() });
  assert.match(f.lines[0], /registered L9 pid=20 cwd=/);
  const row = await f.who(); assert.equal(row.identity, "launched"); assert.equal(row.pid, 20); assert.ok(row.evidence.includes("registration"));
});
for (const comm of ["pi", "/opt/bin/pi"]) test(`register finds nearest Pi ancestor (${comm}) rather than shell or wrapper`, async () => {
  const f = fixture(); const cwd = join(f.home, "pi-cwd"); mkdirSync(cwd);
  f.ctx.readCwd = async pid => pid === 20 ? cwd : undefined;
  f.ctx.env.PI_ORCH_PID = "99";
  f.ctx.run = async () => ({ code: 0, stdout: `${process.pid} 30 bash\n30 20 sh\n20 10 ${comm}\n10 1 pi-session`, stderr: "", timedOut: false });
  assert.equal(await f.invoke("register", "L9"), 0); assert.equal(f.record().pid, 20); assert.equal(f.record().cwd, realpathSync(cwd));
});
test("unavailable process cwd falls back to command cwd", async () => {
  const f = fixture(); f.ctx.readCwd = async () => undefined;
  assert.equal(await f.invoke("register", "L9"), 0); assert.equal(f.record().cwd, realpathSync(f.home));
});
for (const mode of ["missing", "cycle", "failed", "timeout", "long", "throws"]) test(`ancestor discovery refuses safely: ${mode}`, async () => {
  const f = fixture(); const table = mode === "cycle" ? `${process.pid} 30 bash\n30 ${process.pid} sh`
    : mode === "long" ? `${process.pid} 1000 bash\n${Array.from({ length: 66 }, (_, i) => `${1000 + i} ${1001 + i} sh`).join("\n")}\n1066 1 pi`
    : `${process.pid} 1 bash\n1 0 init`;
  f.ctx.run = async () => { if (mode === "throws") throw new Error("ps unavailable"); return { code: mode === "failed" ? 1 : 0, stdout: table, stderr: "", timedOut: mode === "timeout" }; };
  assert.equal(await f.invoke("register", "L9"), 1); assert.match(f.errors.at(-1)!, /no pi process found among ancestors; pass --pid/); assert.equal(existsSync(f.path), false);
});
test("dead explicit pid refuses and invalid pid options are usage errors", async () => {
  const f = fixture(); f.ctx.pidAlive = () => false;
  assert.equal(await f.invoke("register", "L9", "--pid", "20"), 1); assert.match(f.errors.at(-1)!, /not alive/);
  for (const pid of ["0", "-1", "abc", "1.5", "9007199254740992"]) assert.equal(await f.invoke("register", "L9", `--pid=${pid}`), 2);
  assert.equal(existsSync(f.path), false);
});
for (const id of ["l1", "L 1", "../X", "A".repeat(33)]) test(`invalid registration id ${id} is a usage error`, async () => {
  const f = fixture(); assert.equal(await f.invoke("register", id, "--pid", "20"), 2);
  assert.equal(await f.invoke("unregister", id), 2); assert.equal(existsSync(join(f.home, ".state/roster")), false);
});
test("cwd must exist and be a directory", async () => {
  const f = fixture(); const file = join(f.home, "file"); writeFileSync(file, "text");
  for (const cwd of [file, join(f.home, "missing")]) assert.equal(await f.invoke("register", "L9", "--pid", "20", "--cwd", cwd), 1);
  assert.equal(existsSync(f.path), false);
});
test("a live ID refuses a different pid and is idempotent for its owner", async () => {
  const f = fixture(); f.put(); const before = f.record(); f.tick();
  assert.equal(await f.invoke("register", "L9", "--pid", "21"), 1); assert.match(f.errors.at(-1)!, /already registered to pid 20 \(/);
  assert.deepEqual(f.record(), before);
  assert.equal(await f.invoke("register", "L9", "--pid", "20"), 0); assert.deepEqual(f.record(), before);
});
for (const mode of ["dead", "retired", "cwd-mismatch"]) test(`register replaces a ${mode} record`, async () => {
  const f = fixture(); f.put(mode === "retired" ? { retiredAt: f.ctx.now().toISOString() } : {}); f.tick();
  if (mode === "dead") f.ctx.pidAlive = pid => pid === 21;
  if (mode === "cwd-mismatch") { const cwd = join(f.home, "elsewhere"); mkdirSync(cwd); f.ctx.readCwd = async () => cwd; }
  assert.equal(await f.invoke("register", "L9", "--pid", "21", "--cwd", f.home), 0);
  assert.deepEqual(f.record(), { id: "L9", pid: 21, cwd: realpathSync(f.home), startedAt: f.ctx.now().toISOString() });
});
test("unregister retires once, permits re-register, and refuses unknown IDs", async () => {
  const f = fixture(); assert.equal(await f.invoke("unregister", "L9"), 1); assert.match(f.errors.at(-1)!, /not registered/);
  assert.equal(await f.invoke("register", "L9", "--pid", "20"), 0); f.tick();
  assert.equal(await f.invoke("unregister", "L9"), 0); const retired = f.record(); assert.equal(retired.retiredAt, f.ctx.now().toISOString());
  f.ctx.run = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
  assert.equal((await f.who()).state, "retired"); f.tick();
  assert.equal(await f.invoke("unregister", "L9"), 0); assert.deepEqual(f.record(), retired);
  assert.equal(await f.invoke("register", "L9", "--pid", "20"), 0); assert.equal(f.record().retiredAt, undefined);
});
test("register leaves configured lane definitions untouched and rejects unsupported options", async () => {
  const f = fixture(); const path = join(f.home, "lanes.json"); const before = readFileSync(path, "utf8");
  assert.equal(await f.invoke("register", "L9", "--pid", "20"), 0);
  assert.equal(readFileSync(path, "utf8"), before);
  for (const args of [["register"], ["unregister"], ["register", "L9", "EXTRA"], ["register", "L9", "--force"], ["register", "L9", "--pid"], ["unregister", "L9", "--pid", "20"]]) assert.equal(await f.invoke(...args), 2);
});
test("registered sessions become stopped after their pid exits", async () => {
  const f = fixture(); assert.equal(await f.invoke("register", "L9", "--pid", "20"), 0);
  f.ctx.pidAlive = () => false; f.ctx.run = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
  assert.equal((await f.who()).state, "stopped");
});
