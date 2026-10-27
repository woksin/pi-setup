import { strict as assert } from "node:assert";
import { delimiter } from "node:path";
import { realContext, realRun, realWhich } from "../../src/context.ts";
import { CANCEL } from "../../src/types.ts";
import type { Ctx, Prompter, RunResult } from "../../src/types.ts";
import { REPO, assertTempHome, testCtx } from "./home.ts";
import type { Sandbox } from "./home.ts";

/** Every child and writable path stays inside the throwaway HOME. */
export function ctxFor(box: Sandbox, lines: string[] = [], errs: string[] = []): Ctx {
  assertTempHome(box.home);
  const env = {
    HOME: box.home, TMPDIR: box.root, STUB_LOG: box.log, STUB_READY: "anthropic,openai-codex,kimi-coding",
    PATH: [box.stubs, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
  };
  return {
    ...realContext(REPO), env, home: box.home, cwd: REPO, stdinTTY: true, stdoutTTY: true, which: realWhich(env),
    run: (cmd, args, o) => {
      assert.equal(o?.env?.HOME ?? env.HOME, box.home);
      return realRun(cmd, args, { ...o, env: { ...env, ...o?.env } });
    },
    out: (l) => lines.push(l), err: (l) => errs.push(l),
  };
}

const result = (value: Partial<RunResult>): RunResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...value });

interface Probe { ctx: Ctx; cmd: string; args: string[] }

function githubProbe({ ctx, args }: Probe): RunResult {
  const login = ctx.env.STUB_LOGIN;
  if (!login) return result({ code: 1 });
  const responses: Record<string, string> = {
    "auth status": `Logged in to github.com account ${login}`,
    "api user --jq .login": login,
    "api user/orgs --jq .[].login": "Cratis",
  };
  assert.ok(args.join(" ") in responses, `unexpected gh probe: ${args}`);
  return result({ stdout: responses[args.join(" ")] });
}

function piProbe({ ctx, args }: Probe): RunResult {
  if (args.join(" ") === "--offline --list-models") return result({ stdout: "No models available." });
  assert.deepEqual(args, ["auth", "check", "--provider", args[3], "--no-refresh", "--json"]);
  const status = ctx.env.STUB_READY?.split(",").includes(args[3]) ? "ready" : "not_ready";
  return result({ stdout: JSON.stringify({ status, authType: "oauth" }), code: status === "ready" ? 0 : 1 });
}

function gitProbe({ ctx, args }: Probe): RunResult {
  if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") return result({ code: 1 });
  assert.equal(args[0], "-C");
  assert.equal(args[1], ctx.repoDir);
  const command = args.slice(2).join(" ");
  if (command === "describe --tags --exact-match HEAD") return result({ code: 1 });
  assert.equal(command, "rev-parse HEAD");
  return result({ stdout: "0123456789012345678901234567890123456789" });
}

function runProbe(probe: Probe): RunResult {
  const { cmd, args } = probe;
  if (args.length === 1 && args[0] === "--version") return result({ stdout: cmd === "python3" ? "Python 3.12.0" : "1.4.0" });
  if (cmd === "id") return result({ stdout: "1000\n" });
  if (cmd === "npm" && args[0] === "prefix") return result({ stdout: "/nonexistent/prefix\n" });
  if (cmd === "gh") return githubProbe(probe);
  if (cmd === "pi") return piProbe(probe);
  if (cmd === "git") return gitProbe(probe);
  throw new Error(`unexpected rails command: ${cmd} ${args.join(" ")}`);
}

/** Rails unit tests exercise the real filesystem flow, not host process-startup deadlines. */
export function railsCtxFor(box: Sandbox, output: { lines?: string[]; errors?: string[] } = {}): Ctx {
  const tools = new Set(["pi", "python3", "jq", "git", "gh", "docker", "dotnet", "rsync", "npm"]);
  const ctx = testCtx(box.home, {
    cwd: box.home, stdinTTY: true, stdoutTTY: true,
    env: { HOME: box.home, STUB_LOGIN: "einari", STUB_READY: "anthropic,openai-codex,kimi-coding" },
    which: (name) => tools.has(name) ? `${box.stubs}/${name}` : undefined,
  }, output.lines, output.errors);
  ctx.run = async (cmd, args) => runProbe({ ctx, cmd, args });
  return ctx;
}

/** Accept the rails shell without changing a caller's other interactive choices. */
export function installationChoice({ message }: { message: string }): string | typeof CANCEL {
  const answers = new Map([
    ["How do you want to set up?", "recommended"], ["Review", "install"],
    ["Log in to your AI providers", "continue"], ["Install pi first", "continue"],
  ]);
  return answers.get(message) ?? CANCEL;
}

/** Answers are queued by message substring; unspecified answers accept the initial value. */
export function scripted(answers: Record<string, unknown[]> = {}) {
  const events: string[] = [];
  const notes: string[] = [];
  const offered: string[][] = [];
  const steps: string[] = [];
  const outros: string[] = [];
  const selects: { message: string; initial?: string; labels: string[] }[] = [];
  const answer = (kind: string, message: string, fallback: unknown) => {
    events.push(`${kind}:${message}`);
    const queue = Object.entries(answers).find(([key]) => message.includes(key))?.[1];
    return Promise.resolve(queue?.length ? queue.shift() : fallback);
  };
  const p: Prompter = {
    intro: () => {}, outro: (message) => outros.push(message), note: (body) => notes.push(body),
    step: (i, n, title) => steps.push(`Step ${i} of ${n} · ${title}`),
    spinner: () => ({ start: () => {}, stop: () => {} }),
    confirm: (o) => answer("confirm", o.message, o.message === "Set up a coordinator and lanes now?" ? false : o.initial ?? true) as never,
    select: (o) => {
      offered.push(o.options.map((x) => x.value));
      selects.push({ message: o.message, initial: o.initial, labels: o.options.map((x) => x.label) });
      return answer("select", o.message, o.initial) as never;
    },
    text: (o) => answer("text", o.message, o.initial ?? "") as never,
    multiselect: (o) => answer("multiselect", o.message, o.initial) as never,
    isCancel: (v) => v === CANCEL,
  };
  return { p, events, notes, offered, steps, outros, selects };
}
