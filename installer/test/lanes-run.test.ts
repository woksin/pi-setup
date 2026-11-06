import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { laneCtx } from "./lanes-terminal.test.ts";
import { defaults, validate } from "../src/lanes/config.ts";
import { run } from "../src/lanes/commands/run.ts";
import { admit, type AdmissionProcess } from "../src/lanes/admission.ts";
import { parseStatus, suppressed } from "../src/lanes/status-line.ts";
import { tempDir, REPO } from "./helpers/home.ts";

test("run holds lease through wrapper relaunch, forwards verified cancellation, exit and environment", async () => {
  const rows: AdmissionProcess[] = [{ pid: process.pid, ppid: 1, start: "owner", pi: false }];
  const ctx = laneCtx({ which: () => "/fake/pi-session", admissionInventory: async () => rows,
    env: { PI_MCP_CONFIG_MODE: "remove", KEEP: "yes" } });
  const c = defaults(ctx.home, ctx.home); mkdirSync(join(ctx.home, "prompts")); writeFileSync(join(ctx.home, c.coordinator.prompt), "test");
  let finish!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let spawned!: () => void; const ready = new Promise<void>(resolve => { spawned = resolve; });
  const signals: string[] = [];
  ctx.spawnInherited = (exe, args, options) => {
    assert.equal(exe, "/fake/pi-session"); assert.deepEqual(args, [`@${join(ctx.home, c.coordinator.prompt)}`]);
    assert.equal(options.cwd, ctx.home); assert.equal(options.env.PI_ORCH_ID, "L0"); assert.equal(options.env.KEEP, "yes"); assert.equal(options.env.PI_MCP_CONFIG_MODE, undefined);
    rows.push({ pid: 20, ppid: process.pid, start: "wrapper", pi: false });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { finish = resolve; });
    spawned(); return { pid: 20, done, signal: s => { signals.push(s); } };
  };
  const running = run("coordinator", {}, c, ctx.home, ctx); await ready;
  // Wait for the asynchronous identity probe, not a model or terminal.
  await new Promise(resolve => setImmediate(resolve));
  process.emit("SIGTERM"); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(signals, ["SIGTERM"]);
  rows.push({ pid: 30, ppid: 20, start: "pi-first", pi: true, cwd: ctx.home });
  await assert.rejects(admit(ctx, { root: ctx.home, cwd: ctx.home, id: "L0", pool: "orchestration", localLimit: 6 }), /already running/);
  rows.pop(); rows.push({ pid: 31, ppid: 20, start: "pi-relaunch", pi: true, cwd: ctx.home });
  const files = readdirSync(join(ctx.piAgentDir, "lanes-admission")).filter(n => n.endsWith(".json")); assert.equal(files.length, 1);
  rows.splice(1); finish({ code: 17, signal: null }); assert.equal(await running, 17);
  assert.deepEqual(readdirSync(join(ctx.piAgentDir, "lanes-admission")), []);
});
test("missing legacy local limit defaults safely, role values remain validated; parked never auto-expires", () => {
  const ctx = laneCtx(); const c = defaults(ctx.home, ctx.home); assert.equal(c.coordinator.maxRunning, 6);
  delete (c.coordinator as any).maxRunning; validate(c, ctx.home); assert.equal(c.coordinator.maxRunning, 6);
  for (const now of [0, Date.now() * 2]) {
    const line = 'parked "review / L0" until 2026-01-01T00:00:00Z'; assert.equal(parseStatus(line).kind, "parked"); assert.equal(suppressed(line, new Date(now)), true);
  }
});
test("printed bundled command reserves nothing; execution admits an isolated inherited-stdio fake wrapper", () => {
  const home = tempDir("lanes-run-cli"); const root = join(home, "root"); const bin = join(home, "bin"); mkdirSync(bin);
  const childFile = join(home, "child.pid"); const agent = join(home, "agent");
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PATH: `${bin}:${process.env.PATH}`, CHILD_FILE: childFile };
  for (const key of ["LANES_DIR", "TMUX", "TERM_PROGRAM", "LANES_TEMPLATES"]) delete env[key];
  writeFileSync(join(bin, "pgrep"), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, "ps"), '#!/bin/sh\nprintf "%s 1 Fri Jan 2 03:04:00 2026 node\\n" "$PPID"\nif test -f "$CHILD_FILE"; then p=$(cat "$CHILD_FILE"); if kill -0 "$p" 2>/dev/null; then printf "%s %s Fri Jan 2 03:04:01 2026 wrapper\\n" "$p" "$PPID"; fi; fi\n', { mode: 0o755 });
  writeFileSync(join(bin, "pi-session"), '#!/bin/sh\necho $$ > "$CHILD_FILE"\nprintf "fake-child:%s:%s\\n" "$PI_ORCH_ID" "$1"\nsleep 0.2\nexit 17\n', { mode: 0o755 });
  const cli = join(REPO, "installer/dist/lanes.mjs");
  const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, cwd: home, encoding: "utf8", timeout: 10000 });
  assert.equal(invoke("init", root, "--terminal", "print").status, 0);
  const printed = invoke("--dir", root, "start", "coordinator"); assert.equal(printed.status, 0, printed.stderr);
  const command = printed.stdout.split("\n").find(line => line.startsWith("cd "))!;
  assert.match(command, /lanes\.mjs.*'run' 'L0'/); assert.equal(existsSync(join(agent, "lanes-admission")), false);
  const child = spawnSync("sh", ["-c", command], { env, cwd: home, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 17, child.stderr); assert.match(child.stdout, /fake-child:L0:@/);
  assert.deepEqual(readdirSync(join(agent, "lanes-admission")), []);
});
