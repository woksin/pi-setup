import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { realContext, realRun, realWhich } from "../src/context.ts";
import { COMPONENTS, hintFor } from "../src/components.ts";
import { main } from "../src/run.ts";
import { CANCEL } from "../src/types.ts";
import type { Ctx, Prompter } from "../src/types.ts";
import { REPO, assertTempHome, install, installLines, sandbox } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => rmSync(b.root, { recursive: true, force: true })));

function ctxFor(box: Sandbox, lines: string[], errs: string[]): Ctx {
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

function scripted(answers: Record<string, unknown[]>) {
  const events: string[] = [];
  const notes: string[] = [];
  const answer = (kind: string, message: string, fallback: unknown) => {
    events.push(`${kind}:${message}`);
    const queue = Object.entries(answers).find(([key]) => message.includes(key))?.[1];
    return Promise.resolve(queue?.length ? queue.shift() : fallback);
  };
  const p: Prompter = {
    intro: () => {}, outro: () => {}, note: (body) => notes.push(body), spinner: () => ({ start: () => {}, stop: () => {} }),
    confirm: (o) => answer("confirm", o.message, o.message === "Set up a coordinator and lanes now?" ? false : true) as never,
    select: (o) => answer("select", o.message, o.initial) as never,
    text: (o) => answer("text", o.message, o.initial ?? "") as never,
    multiselect: (o) => Promise.resolve(o.initial) as never,
    isCancel: (v) => v === CANCEL,
  };
  return { p, events, notes };
}

function box(): Sandbox {
  const b = sandbox();
  boxes.push(b);
  return b;
}

const base = (b: Sandbox, extra: string[] = []) => ["--user", "einari", "--skip-npm", ...extra, ...(extra.includes("--repos-root") ? [] : ["--repos-root", join(b.root, "repos")])];

test("(a) a profile picked through Change… is labelled as picked, not as a flag", async () => {
  const b = box();
  const s = scripted({ "Profile ": ["change"], "Pick a profile": ["openai-only"] });
  assert.equal(await main(base(b), ctxFor(b, [], []), s.p), 0);
  const plan = s.notes.find((n) => n.includes("Profile:")) ?? "";
  assert.match(plan, /Profile: openai-only \(you picked it\)/);
  assert.doesNotMatch(plan, /requested with --profile/);
});

test("(b) accepting the pre-selected root does not say 'you typed it'", async () => {
  const b = box();
  const s = scripted({});
  const args = ["--user", "einari", "--skip-npm"];
  assert.equal(await main(args, ctxFor(b, [], []), s.p), 0);
  const plan = s.notes.find((n) => n.includes("Repositories root:")) ?? "";
  assert.doesNotMatch(plan, /Repositories root:.*you typed it/);
  assert.match(plan, /Repositories root:.*(default|best match found|saved)/);
});

test("(c) the guided flow prints a count line, not one line per file", async () => {
  const b = box();
  const lines: string[] = [];
  assert.equal(await main(base(b), ctxFor(b, lines, []), scripted({}).p), 0, lines.join("\n"));
  assert.deepEqual(installLines(lines.join("\n")), []);
  assert.ok(lines.some((l) => /^Wrote \d+ files \(0 changed, 0 backed up\)$/.test(l)), lines.join("\n"));
  const plain = box();
  const out = install(plain, ["--yes", ...base(plain)]);
  assert.ok(installLines(out.stdout).length > 100);
});

test("(d) a rerun with nothing to change does not ask Apply?", async () => {
  const b = box();
  assert.equal(install(b, ["--yes", ...base(b)]).status, 0);
  const s = scripted({});
  assert.equal(await main(base(b), ctxFor(b, [], []), s.p), 0);
  assert.ok(!s.events.includes("confirm:Apply?"), s.events.join("\n"));
  const first = box();
  const f = scripted({});
  assert.equal(await main(base(first), ctxFor(first, [], []), f.p), 0);
  assert.ok(f.events.includes("confirm:Apply?"));
});

test("(e) the Python OK line is printed only without a prompter", async () => {
  const b = box();
  const guided: string[] = [];
  assert.equal(await main(base(b), ctxFor(b, guided, []), scripted({}).p), 0);
  assert.ok(!guided.some((l) => /^Python \d/.test(l)), guided.join("\n"));
  const plain = box();
  // Under heavy load the version probe can time out; then the same line is a stderr warning instead.
  const r = install(plain, ["--yes", ...base(plain)]);
  assert.match(`${r.stdout}\n${r.stderr}`, /^(warning: )?Python (\d|version unknown)/m);
});

test("(f) every extras row has a hint", () => {
  for (const def of COMPONENTS) {
    for (const on of [true, false]) assert.ok(hintFor(def, on).trim().length > 0, def.id);
  }
});
