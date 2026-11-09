import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { probeInBatches, runningPiChecked } from "../src/lanes/processes.ts";

const result = (stdout = "", code = 0, timedOut = false) => ({ stdout, code, timedOut, stderr: "" });
function context(over: Partial<LanesCtx> = {}): LanesCtx {
  return { home: "/unused", cwd: "/unused", env: {}, platform: "darwin", now: () => new Date(0),
    realpath: path => path, run: async () => result(), which: () => undefined, out: () => {}, err: () => {},
    stdinTTY: false, readStdin: async () => "", templatesDir: "/unused", piAgentDir: "/unused", loadModule: async () => ({}), ...over };
}

test("checked discovery parses ps comm exactly, including the macOS PID omitted by pgrep", async () => {
  const calls: string[] = [];
  const ctx = context({ run: async (name, args) => {
    calls.push(`${name} ${args.join(" ")}`);
    if (args.includes("-axo")) return result(" 3571 pi\n21950 pi\n10 pi-helper\n11 /bin/pi\n12 node pi\n");
    return result(`p${args[2]}\nn/worker/${args[2]}\n`);
  } });
  assert.deepEqual(await runningPiChecked(ctx), { ok: true, procs: [{ pid: 3571, cwd: "/worker/3571" }, { pid: 21950, cwd: "/worker/21950" }] });
  assert.equal(calls[0], "ps -axo pid=,comm=");
  assert.ok(calls.includes("lsof -a -p 21950 -d cwd -Fn"));
  assert.ok(!calls.some(c => c.startsWith("pgrep")));
});

test("checked discovery retains Linux cwd fallback and realpath canonicalization", async () => {
  const calls: string[] = [];
  const ctx = context({ platform: "linux", realpath: path => path.replace("alias", "real"), run: async (name, args) => {
    calls.push(`${name} ${args.join(" ")}`);
    return result(args.includes("-axo") ? "701 pi" : "/tmp/alias\n");
  } });
  assert.deepEqual(await runningPiChecked(ctx), { ok: true, procs: [{ pid: 701, cwd: "/tmp/real" }] });
  assert.deepEqual(calls, ["ps -axo pid=,comm=", "readlink /proc/701/cwd"]);
});

test("empty ps output is successful; failed, timed-out or thrown discovery remains unavailable", async () => {
  assert.deepEqual(await runningPiChecked(context()), { ok: true, procs: [] });
  for (const output of [result("", 1), result("", 2), result("701 pi", 0, true)]) {
    assert.deepEqual(await runningPiChecked(context({ run: async () => output })), { ok: false, procs: [] });
  }
  assert.deepEqual(await runningPiChecked(context({ run: async () => { throw new Error("probe failed"); } })), { ok: false, procs: [] });
});

test("malformed process records and unavailable cwd retain incomplete discovery labels", async () => {
  const malformed = context({ run: async () => result("bad row\n701 pi"), readCwd: async () => "/worker" });
  assert.deepEqual(await runningPiChecked(malformed), { ok: false, procs: [{ pid: 701, cwd: "/worker" }] });
  for (const readCwd of [async () => undefined, async () => { throw new Error("gone"); }]) {
    const ctx = context({ run: async () => result("701 pi"), readCwd });
    assert.deepEqual(await runningPiChecked(ctx), { ok: false, procs: [{ pid: 701, cwd: "" }] });
  }
});

test("discovery probes are bounded to four workers and retain input order", async () => {
  let active = 0; let peak = 0;
  const values = Array.from({ length: 12 }, (_, i) => i);
  const output = await probeInBatches(values, async i => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 12 - i));
    active--; return i * 2;
  });
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.deepEqual(output, values.map(i => i * 2));
});
