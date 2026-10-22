import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isInteractive, parseArgs } from "../src/args.ts";

const ok = (argv: string[]) => {
  const r = parseArgs(argv, "/work");
  assert.ok(r.ok, JSON.stringify(r));
  return r.options;
};

test("defaults and the optional install subcommand", () => {
  assert.equal(ok([]).dryRun, false);
  assert.equal(ok(["install", "--dry-run"]).dryRun, true);
});

test("flags with values", () => {
  const o = ok(["--user", "einari", "--repos-root", "rel/dir", "--profile", "auto", "--yes", "--skip-npm", "--plan", "--json"]);
  assert.deepEqual([o.user, o.reposRoot, o.profile], ["einari", "/work/rel/dir", "auto"]);
  assert.ok(o.yes && o.skipNpm && o.plan && o.json);
});

test("absolute and ~ roots are left alone", () => {
  assert.equal(ok(["--repos-root", "/abs"]).reposRoot, "/abs");
  assert.equal(ok(["--repos-root", "~/code"]).reposRoot, "~/code");
});

test("missing values and unknown arguments are errors", () => {
  for (const argv of [["--user"], ["--user", ""], ["--repos-root", "--dry-run"], ["--profile"]]) {
    const r = parseArgs(argv, "/w");
    assert.ok(!r.ok && /^Missing value for --/.test(r.error), argv.join(" "));
  }
  const r = parseArgs(["--unknown"], "/w");
  assert.ok(!r.ok && r.error === "Unknown argument: --unknown");
});

test("interactive needs both TTYs and no CI, --yes, --json, --plan or --dry-run", () => {
  const base = ok([]);
  assert.equal(isInteractive(base, {}, true, true), true);
  assert.equal(isInteractive(base, {}, false, true), false);
  assert.equal(isInteractive(base, {}, true, false), false);
  assert.equal(isInteractive(base, { CI: "1" }, true, true), false);
  for (const flag of ["--yes", "--json", "--plan", "--dry-run"]) assert.equal(isInteractive(ok([flag]), {}, true, true), false, flag);
});
