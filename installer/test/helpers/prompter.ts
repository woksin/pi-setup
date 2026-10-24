import { strict as assert } from "node:assert";
import { delimiter } from "node:path";
import { realContext, realRun, realWhich } from "../../src/context.ts";
import { CANCEL } from "../../src/types.ts";
import type { Ctx, Prompter } from "../../src/types.ts";
import { REPO, assertTempHome } from "./home.ts";
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
