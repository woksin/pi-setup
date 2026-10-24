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
  // Keeping the detected root leaves it to detection, so the plan keeps its scan source (S1).
  assert.deepEqual(await collectChoices(p, input()), { user: "einari", root: undefined, profile: undefined });
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

test("MCP trust confirm is off by default, explained, cancellable and only asked with lanes", async () => {
  const i = input(["--user", "a", "--repos-root", "/x", "--profile", "balanced"]);
  i.extras = () => [{ id: "lanes", label: "lanes", hint: "opt-in", initial: true }];
  const off = scripted([false]); const result = await collectChoices(off.p, i);
  assert.ok(result !== CANCEL); assert.equal(result.preapproveMcp, false);
  assert.match(off.asked[0], /trusts project MCP server definitions/);
  const on = scripted([true]); const enabled = await collectChoices(on.p, i);
  assert.ok(enabled !== CANCEL); assert.equal(enabled.preapproveMcp, true);
  assert.equal(await collectChoices(scripted([CANCEL]).p, i), CANCEL);
  i.options.preapproveMcp = true;
  const fixed = scripted([]); assert.ok(await collectChoices(fixed.p, i) !== CANCEL); assert.equal(fixed.asked.length, 0);
  i.options.preapproveMcp = false; i.preapproveMcp = true;
  const saved = scripted([]); const kept = await collectChoices(saved.p, i);
  assert.ok(kept !== CANCEL); assert.equal(kept.preapproveMcp, true); assert.equal(saved.asked.length, 0);
  i.preapproveMcp = false; i.extras = () => [{ id: "lanes", label: "lanes", hint: "opt-in", initial: false }];
  const disabled = scripted([]); await collectChoices(disabled.p, i); assert.equal(disabled.asked.length, 0);
});

test("installer MCP opt-in flag is install-only and false by default", () => {
  const plain = parseArgs([], "/w"); assert.ok(plain.ok); assert.equal(plain.options.preapproveMcp, false);
  const optIn = parseArgs(["--with", "lanes", "--preapprove-mcp"], "/w"); assert.ok(optIn.ok); assert.equal(optIn.options.preapproveMcp, true);
  assert.equal(parseArgs(["uninstall", "--preapprove-mcp"], "/w").ok, false);
});
