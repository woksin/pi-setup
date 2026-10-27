import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/run.ts";
import { reportRepo } from "../src/setup-issue.ts";
import { install, sandbox, snapshot, testCtx } from "./helpers/home.ts";
import type { RunOptions } from "../src/types.ts";

const boxes: ReturnType<typeof sandbox>[] = [];
afterEach(() => { for (const box of boxes.splice(0)) rmSync(box.root, { recursive: true, force: true }); });

function fixture() {
  const box = sandbox(); boxes.push(box);
  const calls: { cmd: string; args: string[]; options?: RunOptions }[] = [];
  const out: string[] = [];
  const ctx = testCtx(box.home, { run: async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const stdout = cmd === "pi" ? "0.85.1\n" : args[0] === "describe" ? "v1.2.3\n" : "a".repeat(40);
    return { code: 0, stdout, stderr: "", timedOut: false };
  } }, out, out);
  const put = (rel: string, value: unknown) => {
    const path = join(box.home, ".pi/agent", rel);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value));
  };
  return { box, ctx, calls, out, put };
}

test("component owners include scoped package names and reject unknown owners", () => {
  for (const [component, repo] of [
    ["pi-setup", "woksin/pi-setup"], ["installer", "woksin/pi-setup"], ["pi-questions", "woksin/pi-setup"],
    ["@woksin/pi-jobs", "woksin/pi-jobs"], ["pi-recover", "woksin/pi-recover"],
    ["pi-context-budget", "woksin/pi-context-budget"], ["pi-orch", "woksin/pi-orch"],
    ["@gotgenes/pi-anthropic-auth", "gotgenes/pi-anthropic-auth"], ["@tintinweb/pi-subagents", "tintinweb/pi-subagents"],
    ["@vigolium/piolium", "vigolium/piolium"], ["donsetch", "dondai44423/donsetch"],
    ["pi-browser-use", "0xPlayerOne/pi-browser-use"], ["pi-mcp-adapter", "nicobailon/pi-mcp-adapter"],
    ["pi-web-access", "nicobailon/pi-web-access"], ["@earendil-works/pi-coding-agent", "earendil-works/pi"],
    ["pi", "earendil-works/pi"], ["codescene", "codescene-oss/codescene-mcp-server"],
  ]) assert.equal(reportRepo(component), repo, component);
  for (const component of ["unknown", "__proto__", "@unknown/pi-jobs"]) assert.equal(reportRepo(component), undefined);
});

test("report prints installed versions offline without changing HOME or calling gh/npm", async () => {
  const f = fixture();
  f.put(".pi-setup/manifest.json", { source: { release: "v2.3.4", commit: "b".repeat(40) } });
  f.put("npm/node_modules/@woksin/pi-jobs/package.json", { version: "0.3.1" });
  f.put("npm/node_modules/@woksin/pi-orch/package.json", { version: "0.1.1" });
  const before = snapshot(f.box.home);
  assert.equal(await main(["install", "report"], f.ctx), 0);
  const text = f.out.join("\n");
  for (const part of ["Target repository: woksin/pi-setup", "pi-setup: v2.3.4", "pi: 0.85.1", "@woksin/pi-jobs: 0.3.1", "@woksin/pi-orch: 0.1.1", "node:", "OS:"]) assert.ok(text.includes(part), part);
  assert.deepEqual(f.calls.map(c => [c.cmd, c.args]), [["pi", ["--version"]]]);
  assert.equal(f.calls[0].options?.env?.PI_OFFLINE, "1");
  assert.deepEqual(snapshot(f.box.home), before);
});

test("checkout tag or commit is used without an installed manifest", async () => {
  const f = fixture();
  assert.equal(await main(["report"], f.ctx), 0);
  assert.match(f.out.join("\n"), /pi-setup: v1\.2\.3/);
  f.out.length = 0;
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, options) => args[0] === "describe" ? { code: 1, stdout: "", stderr: "", timedOut: false } : run(cmd, args, options);
  assert.equal(await main(["report"], f.ctx), 0);
  assert.ok(f.out.join("\n").includes(`pi-setup: ${"a".repeat(40)}`));
});

test("unavailable tools and unsafe metadata produce no raw diagnostics or private paths", async () => {
  const f = fixture();
  f.put(".pi-setup/manifest.json", { source: { release: "/private/secret", commit: "/private/secret" } });
  f.put("npm/node_modules/@woksin/pi-jobs/package.json", { version: "token=secret" });
  f.ctx.run = async () => ({ code: 1, stdout: "/private/secret", stderr: "token=secret", timedOut: false });
  assert.equal(await main(["report"], f.ctx), 0);
  const text = f.out.join("\n");
  assert.match(text, /pi-setup: unknown/); assert.match(text, /pi: unavailable/);
  assert.match(text, /@woksin\/pi-jobs: unknown/); assert.doesNotMatch(text, /token=secret|\/private\//);
});

test("--open calls gh only for the selected repository with a versions body template", async () => {
  const f = fixture();
  assert.equal(await main(["report", "--component", "pi-jobs", "--open"], f.ctx), 0);
  const call = f.calls.find(c => c.cmd === "gh")!;
  assert.deepEqual(call.args.slice(0, 6), ["issue", "create", "--repo", "woksin/pi-jobs", "--web", "--body"]);
  assert.match(call.args[6], /## What happened/); assert.match(call.args[6], /## Versions/);
  assert.match(call.args[6], /pi: 0\.85\.1/);
  assert.equal(f.calls.filter(c => c.cmd === "gh").length, 1);
  const run = f.ctx.run;
  f.ctx.run = async (cmd, args, options) => cmd === "gh" ? { code: 1, stdout: "", stderr: "", timedOut: false } : run(cmd, args, options);
  assert.equal(await main(["report", "--open"], f.ctx), 1);
  assert.match(f.out.join("\n"), /could not open the issue/);
});

test("unknown component is rejected before probing tools", async () => {
  const f = fixture();
  assert.equal(await main(["report", "--component", "unknown"], f.ctx), 1);
  assert.deepEqual(f.calls, []);
  assert.match(f.out.join("\n"), /unknown report component/);
});

test("shim dispatches report without installing anything", () => {
  const box = sandbox(); boxes.push(box);
  const before = snapshot(box.home);
  const result = install(box, ["report", "--component", "pi-jobs"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Target repository: woksin\/pi-jobs/);
  assert.match(result.stdout, /## Versions/);
  assert.deepEqual(snapshot(box.home), before);
});
