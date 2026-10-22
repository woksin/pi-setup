import { strict as assert } from "node:assert";
import { test } from "node:test";
import { detect, parseAuthStatus, parseModelTable, parseProviderCheck, readyProviders } from "../src/detect.ts";
import type { Ctx, Runner } from "../src/types.ts";

function fakeCtx(run: Runner, which: (n: string) => string | undefined = (n) => `/bin/${n}`): Ctx {
  return {
    env: {}, platform: "linux", home: "/nonexistent-home", cwd: "/", repoDir: "/nonexistent-repo", now: () => new Date(0),
    run, which, stdinTTY: false, stdoutTTY: false, nodeVersion: "v22.19.0", out: () => {}, err: () => {},
  };
}
const request = { needLogin: true, wantGithubDetails: true, needScan: false, probePi: true };
const done = (stdout = "", code = 0) => ({ code, stdout, stderr: "", timedOut: false });

test("parsers", () => {
  assert.deepEqual(parseAuthStatus("github.com\n  ✓ Logged in to github.com account einari (keyring)"), { host: "github.com", login: "einari" });
  assert.deepEqual(parseAuthStatus("You are not logged in"), {});
  assert.deepEqual(parseProviderCheck('{"status":"ready","authType":"oauth"}'), { status: "ready", authType: "oauth", reason: undefined });
  assert.equal(parseProviderCheck('{"status":"not_ready","reason":"credentials_not_configured"}').status, "not_ready");
  assert.equal(parseProviderCheck("garbage").status, "unknown");
  const table = "provider   model        context\nanthropic  claude-opus  1M\nkimi-coding k3-256k 256K\n";
  assert.deepEqual([...(parseModelTable(table) ?? [])], ["anthropic/claude-opus", "kimi-coding/k3-256k"]);
  assert.equal(parseModelTable("No models available."), null);
});

test("detect uses --no-refresh and never --credentials or --show-token; a timeout is unknown", async () => {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "pi" && args[0] === "auth") {
      if (args[3] === "kimi-coding") return { code: null, stdout: "", stderr: "", timedOut: true };
      return args[3] === "anthropic" ? done('{"status":"ready"}') : done('{"status":"not_ready"}', 1);
    }
    if (cmd === "pi" && args[0] === "--offline") return done("No models available.\n");
    if (cmd === "gh" && args[0] === "api") return done("einari\n");
    return done("tool 1.0\n");
  };
  const detection = await detect(fakeCtx(run), request);
  assert.deepEqual([...readyProviders(detection)], ["anthropic"]);
  assert.equal(detection.providers["kimi-coding"].status, "unknown");
  assert.equal(detection.github.login, "einari");
  assert.ok(calls.filter((c) => c.startsWith("pi auth check")).every((c) => c.includes("--no-refresh") && !c.includes("--credentials")));
  assert.ok(!calls.some((c) => /--show-token|\s-t(\s|$)/.test(c)));
  assert.ok(detection.warnings.length === 1);
});

test("without probePi or pi on PATH no pi command runs", async () => {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => (calls.push(`${cmd} ${args.join(" ")}`), done("v\n"));
  await detect(fakeCtx(run), { ...request, probePi: false });
  await detect(fakeCtx(run, (n) => (n === "pi" ? undefined : `/bin/${n}`)), request);
  assert.ok(!calls.some((c) => c.startsWith("pi auth") || c.startsWith("pi --offline")));
});

test("no gh probes when nothing needs them", async () => {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => (calls.push(`${cmd} ${args.join(" ")}`), done("v\n"));
  await detect(fakeCtx(run), { needLogin: false, wantGithubDetails: false, needScan: false, probePi: false });
  assert.ok(!calls.some((c) => c.startsWith("gh auth") || c.startsWith("gh api")));
});
