import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, REPO } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { main } from "../src/lanes/cli.ts";
import { loadConfig, saveConfig } from "../src/lanes/config.ts";
import { renderTemplate } from "../src/lanes/templates.ts";
function fixture() {
  const home = tempDir("lanes-commands"); const lines: string[] = []; const errors: string[] = []; const calls: string[] = [];
  const ctx: LanesCtx = { home, cwd: home, env: {}, platform: "linux", now: () => new Date(2026, 0, 2, 3, 4),
    run: async (name, args) => { calls.push(`${name} ${args.join(" ")}`); return { code: 1, stdout: "", stderr: "no", timedOut: false }; },
    which: () => undefined, out: (s) => lines.push(s), err: (s) => errors.push(s), stdinTTY: true, readStdin: async () => "stdin body",
    templatesDir: join(REPO, "installer/lanes/templates"), piAgentDir: join(home, "agent"), loadModule: async () => ({}), realpath: (p) => p };
  return { home, lines, errors, calls, ctx };
}
function snapshot(root: string): unknown {
  return readdirSync(root).sort().map((name) => { const p = join(root, name); const s = statSync(p); return [name, s.mtimeMs, s.isDirectory() ? snapshot(p) : readFileSync(p, "utf8")]; });
}
test("init is idempotent, merges gitignore, renders templates and preserves user content", async () => {
  const { ctx, home, lines } = fixture(); writeFileSync(join(home, ".gitignore"), "custom/\n");
  assert.equal(await main(["init", home, "--terminal", "print"], ctx), 0);
  assert.equal(readFileSync(join(home, ".gitignore"), "utf8"), "custom/\n.state/\nmessages/\n");
  for (const p of ["rules.md", "prompts/coordinator.md", "coordinator/WATCHES.md", "coordinator/handoff-protocol.md"]) assert.ok(!readFileSync(join(home, p), "utf8").includes("{{"));
  writeFileSync(join(home, "rules.md"), "my rules"); const before = snapshot(home);
  assert.equal(await main(["init", home], ctx), 0); assert.deepEqual(snapshot(home), before);
  assert.ok(lines.some((s) => s.startsWith("kept ")));
  assert.equal(renderTemplate("{{known}} {{unknown}}", { known: "ok" }), "ok {{unknown}}");
});
test("send validates input, warns on unknown recipient and reads text, file and stdin", async () => {
  const { ctx, home, errors, lines } = fixture(); await main(["init", home], ctx);
  assert.equal(await main(["send", "L1", "x", "-m", "hi"], ctx), 2); assert.equal(errors.pop(), "set --from or PI_ORCH_ID");
  assert.equal(await main(["send", "L1", "../x", "-m", "hi", "--from", "L0"], ctx), 2);
  ctx.env.PI_ORCH_ID = "L0";
  assert.equal(await main(["send", "L1", "hello", "-m", "hi"], ctx), 0); assert.match(errors.pop()!, /unknown recipient/);
  assert.equal(readFileSync(lines.at(-1)!, "utf8"), "hi");
  const file = join(home, "body"); writeFileSync(file, "file body");
  assert.equal(await main(["send", "ALL", "hello", file], ctx), 0);
  assert.equal(await main(["send", "ALL", "hello", "-"], ctx), 0);
  assert.equal(await main(["send", "ALL", "hello", "-m", ""], ctx), 2);
  assert.equal(await main(["send", "../x", "hello", "-m", "body"], ctx), 2);
});
test("start handles print fallback, duplicate cwd, missing inputs and terminal failure", async () => {
  const { ctx, home, lines, errors } = fixture(); await main(["init", home, "--terminal", "print"], ctx);
  assert.equal(await main(["start", "coordinator"], ctx), 0); assert.match(lines.at(-1)!, /^cd .*PI_ORCH_ID=L0.*pi-session.*@/);
  assert.ok(errors.some((s) => /not found/.test(s)));
  assert.equal(lines.filter((s) => s.startsWith("MCP preapproval is off;")).length, 1);
  assert.equal(await main(["start", "L9"], ctx), 1);
  ctx.run = async () => ({ code: 0, stdout: "123\n", stderr: "", timedOut: false }); ctx.readCwd = async () => home;
  assert.equal(await main(["start", "coordinator"], ctx), 1); assert.equal(errors.at(-1), `already running in ${home} (pid 123); not starting a second session`);
  ctx.run = async () => ({ code: 1, stdout: "", stderr: "fail", timedOut: false }); delete ctx.readCwd;
  assert.equal(await main(["start", "coordinator", "--terminal", "iterm"], ctx), 1); assert.equal(errors.at(-1), "pi not found");
  ctx.which = (name) => name === "pi" ? "/stub/pi" : undefined;
  assert.equal(await main(["start", "coordinator", "--terminal", "iterm"], ctx), 1); assert.match(lines.at(-1)!, /\/stub\/pi/);
  const c = loadConfig(home); c.coordinator.prompt = "missing"; saveConfig(home, c);
  assert.equal(await main(["start", "coordinator"], ctx), 1);
});
test("status is read-only, shows coordinator, missing worktrees, status and messages", async () => {
  const { ctx, home, lines } = fixture(); await main(["init", home], ctx);
  const c = loadConfig(home); c.lanes.push({ id: "L1", repo: "example/alpha", group: null, worktree: "missing", branch: "l1-test", prompt: "prompts/L1.md" }); saveConfig(home, c);
  await main(["send", "L1", "hello", "-m", "hi", "--from", "L0"], ctx);
  writeFileSync(join(home, "messages/status/L1.status"), "waiting-on test\n");
  const before = snapshot(home); assert.equal(await main(["status"], ctx), 0); assert.deepEqual(snapshot(home), before);
  assert.match(lines.at(-1)!, /L1.*example\/alpha.*l1-test.*missing.*waiting-on test.*L0-to-L1/);
});
test("add validation, clone errors and undo after a worktree failure", async () => {
  const { ctx, home, errors } = fixture(); await main(["init", home], ctx);
  for (const args of [["ALL", "--repo", "example/alpha"], ["L1", "--repo", "../alpha"], ["L1", "--repo", "example/alpha", "--issue", "no"], ["L1", "--repo", "example/alpha", "--group", "bad"]]) assert.equal(await main(["add", ...args], ctx), 2);
  assert.equal(await main(["add", "L1", "--repo", "example/alpha"], ctx), 1); assert.match(errors.at(-1)!, /clone it first: gh repo clone/);
  const calls: string[] = [];
  ctx.run = async (_cmd, args) => {
    calls.push(args.join(" ")); const fail = args.includes("lock");
    return { code: args.includes("show-ref") || fail ? 1 : 0, stdout: args.includes("get-url") ? "https://host/example/alpha.git\n" : "ok\n", stderr: "lock failed", timedOut: false };
  };
  assert.equal(await main(["add", "L1", "--repo", "example/alpha"], ctx), 1);
  assert.match(errors.at(-1)!, /worktree unlock .* && git -C .*worktree remove .* && git -C .*branch -D/);
  assert.ok(!calls.some((s) => /worktree (remove|unlock)/.test(s))); assert.equal(loadConfig(home).lanes.length, 0);
});
test("CLI rejects unknown options and usage", async () => {
  const { ctx } = fixture();
  for (const args of [[], ["wat"], ["--dir"], ["init", "--bad"], ["init", "--terminal", "bad"], ["status", "extra"]]) assert.equal(await main(args, ctx), 2);
  assert.equal(await main(["--help"], ctx), 0);
});

test("MCP trust defaults off, explicit opt-in is explained and reruns preserve saved values", async () => {
  const { ctx, home } = fixture();
  assert.equal(await main(["init", home], ctx), 0); assert.equal(loadConfig(home).launch.preapproveMcp, false);
  assert.equal(await main(["init", home, "--preapprove-mcp"], ctx), 0); assert.equal(loadConfig(home).launch.preapproveMcp, false);
  const other = join(home, "opt-in");
  assert.equal(await main(["init", other, "--preapprove-mcp"], ctx), 0); assert.equal(loadConfig(other).launch.preapproveMcp, true);
  assert.equal(await main(["init", other], ctx), 0); assert.equal(loadConfig(other).launch.preapproveMcp, true);
});
