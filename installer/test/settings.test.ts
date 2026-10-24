import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deepEqual, mergeUserJson, readSettings, render, resolveSettings, validLogin } from "../src/settings.ts";

const base = { flagUser: "", flagRoot: "", saved: {}, home: "/home/u", repoDir: "/repo" };

test("login: flag, then saved, then detected; otherwise an error", () => {
  assert.equal(resolveSettings({ ...base, flagUser: "a", saved: { githubUser: "b" }, detectedUser: "c" }).githubUser, "a");
  assert.equal(resolveSettings({ ...base, saved: { githubUser: "b" }, detectedUser: "c" }).userSource, "saved");
  assert.equal(resolveSettings({ ...base, detectedUser: "c" }).userSource, "detected");
  assert.throws(() => resolveSettings(base), /Cannot determine GitHub login; pass --user <login> \(or authenticate gh\)\./);
});

test("read-only runs without a login use the <you> placeholder and a note; real installs still error", () => {
  const r = resolveSettings({ ...base, readOnly: true });
  assert.deepEqual([r.githubUser, r.userSource], ["<you>", "placeholder"]);
  assert.ok(r.warnings.some((w) => /pass --user/.test(w)));
  assert.equal(resolveSettings({ ...base, readOnly: true, flagUser: "a" }).warnings.length, 0);
  assert.throws(() => resolveSettings({ ...base, readOnly: false }), /Cannot determine GitHub login/);
});

test("login validation", () => {
  for (const bad of ["-a", "a-", "a b", "a/b", "x".repeat(40)]) assert.equal(validLogin(bad), false, bad);
  for (const good of ["a", "einari", "some-user", "x".repeat(39)]) assert.equal(validLogin(good), true, good);
  assert.throws(() => resolveSettings({ ...base, flagUser: "bad user" }), /Invalid GitHub login; pass --user <login>\./);
});

test("root: flag, saved, scan, then ~/repos; ~ expands and relative saved resolves against the repo", () => {
  const u = { ...base, flagUser: "a" };
  assert.equal(resolveSettings({ ...u, flagRoot: "~/x" }).reposRoot, "/home/u/x");
  assert.equal(resolveSettings({ ...u, saved: { reposRoot: "rel" } }).reposRoot, "/repo/rel");
  assert.equal(resolveSettings({ ...u, scanRoot: "/scan" }).rootSource, "scan");
  const d = resolveSettings(u);
  assert.deepEqual([d.reposRoot, d.rootSource], ["/home/u/repos", "default"]);
});

test("root rejects quotes, $, backticks and backslashes; a space only warns", () => {
  for (const bad of ['/a"b', "/a'b", "/a$b", "/a`b", "/a\\b"]) {
    assert.throws(() => resolveSettings({ ...base, flagUser: "a", flagRoot: bad }), /single-line path without quotes/, bad);
  }
  assert.equal(resolveSettings({ ...base, flagUser: "a", flagRoot: "/a b" }).warnings.length, 1);
});

test("readSettings: missing is empty; bad JSON, non-object and blank values are errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "pisetup-settings."));
  try {
    const file = join(dir, "user.json");
    assert.deepEqual(readSettings(file), {});
    for (const text of ["{", "[]", '{"githubUser":""}', '{"reposRoot":3}']) {
      writeFileSync(file, text);
      assert.throws(() => readSettings(file), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), text);
    }
    writeFileSync(file, '{"githubUser":"a","orchRepoRoot":"/x"}');
    assert.equal(readSettings(file).orchRepoRoot, "/x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("render is a literal global replace", () => {
  const out = render(Buffer.from("{{GITHUB_USER}} {{GITHUB_USER}} {{REPOS_ROOT}}/x"), { githubUser: "e", reposRoot: "/a & b/$1" });
  assert.equal(out.toString(), "e e /a & b/$1/x");
});

test("merge owns two keys, keeps the rest in order; deepEqual ignores key order", () => {
  const merged = mergeUserJson({ orchRepoRoot: "/k", githubUser: "old" }, { githubUser: "n", reposRoot: "/r" });
  assert.deepEqual(Object.keys(merged), ["orchRepoRoot", "githubUser", "reposRoot"]);
  assert.ok(deepEqual({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 2 }));
});
