import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { collectChoices, confirmApply } from "../src/wizard.ts";
import type { WizardInput } from "../src/wizard.ts";
import { CANCEL } from "../src/types.ts";
import type { Prompter } from "../src/types.ts";

function scripted(answers: unknown[]): { p: Prompter; asked: string[] } {
  const asked: string[] = [];
  const next = (message: string) => {
    asked.push(message);
    return Promise.resolve(answers.shift() as never);
  };
  const p: Prompter = {
    intro: () => {}, outro: () => {}, note: () => {}, spinner: () => ({ start: () => {}, stop: () => {} }),
    confirm: (o) => next(o.message), select: (o) => next(o.message), text: (o) => next(o.message),
    multiselect: (o) => Promise.resolve(o.initial) as never,
    isCancel: (v) => v === CANCEL,
  };
  return { p, asked };
}

function input(args: string[] = [], saved: Record<string, unknown> = {}): WizardInput {
  const parsed = parseArgs(args, "/w");
  assert.ok(parsed.ok);
  return {
    options: parsed.options, saved, home: "/h", repoDir: "/r",
    detection: {
      os: "linux", tools: [], github: { login: "einari", orgs: [] }, providers: {}, hints: { codexAuthFile: false, claudeDir: false },
      catalog: null, candidates: [{ path: "/h/code", score: 4 }], warnings: [],
    },
    profiles: [{ name: "balanced", summary: "s", requires: [], uses: [], rank: 1 }],
    initial: { name: "balanced", reason: "r", provisional: false, source: "chooser" },
  };
}

test("accepting every default asks login, root and profile once each", async () => {
  const { p, asked } = scripted([true, "/h/code", "keep"]);
  assert.deepEqual(await collectChoices(p, input()), { user: "einari", root: "/h/code", profile: undefined });
  assert.equal(asked.length, 3);
});

test("flags skip their questions", async () => {
  const { p, asked } = scripted(["keep"]);
  const result = await collectChoices(p, input(["--user", "a", "--repos-root", "/x"]));
  assert.deepEqual(result, { user: undefined, root: undefined, profile: undefined });
  assert.equal(asked.length, 1);
});

test("overriding the login and picking Other… asks for text; Change… lists profiles", async () => {
  const { p } = scripted([false, "someone", "", "/typed", "change", "balanced"]);
  assert.deepEqual(await collectChoices(p, input()), { user: "someone", root: "/typed", profile: "balanced" });
});

test("cancel at any step returns CANCEL and asks nothing further", async () => {
  for (let step = 0; step < 3; step++) {
    const answers: unknown[] = [true, "/h/code", "keep"];
    answers[step] = CANCEL;
    const { p, asked } = scripted(answers);
    assert.equal(await collectChoices(p, input()), CANCEL);
    assert.equal(asked.length, step + 1);
  }
});

test("confirmApply is true only on an explicit yes", async () => {
  assert.equal(await confirmApply(scripted([true]).p, ["x"]), true);
  assert.equal(await confirmApply(scripted([false]).p, ["x"]), false);
  assert.equal(await confirmApply(scripted([CANCEL]).p, ["x"]), false);
});
