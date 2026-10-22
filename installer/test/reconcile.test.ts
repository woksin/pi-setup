import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { emptyManifest, sha256 } from "../src/manifest.ts";
import { applyTakes, reconcile } from "../src/reconcile.ts";
import type { Action } from "../src/types.ts";
import { tempDir } from "./helpers/home.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function setup() {
  const home = tempDir("pisetup-reconcile");
  dirs.push(home);
  mkdirSync(join(home, ".pi/agent"), { recursive: true });
  return { home, path: join(home, ".pi/agent/f.md") };
}
const want = Buffer.from("new");
const install = (path: string, existed: boolean, extra: Partial<Extract<Action, { op: "install" }>> = {}): Action =>
  ({ op: "install", path, content: want, mode: 0o644, existed, ...extra });
function manifestFor(path: string, home: string, installed: string) {
  const m = emptyManifest(new Date());
  m.files[path.slice(home.length + 1)] = { sha256: sha256(installed), mode: 420, source: { release: null, commit: null }, origin: "new" };
  return m;
}

test("missing file: install as new, with or without a manifest entry", () => {
  const { home, path } = setup();
  const m = manifestFor(path, home, "old");
  for (const manifest of [undefined, m]) {
    const r = reconcile([install(path, false)], manifest, home);
    assert.equal((r.actions[0] as { decision: string }).decision, "new");
    assert.deepEqual(r.conflicts, []);
  }
});

test("adopt passes through unchanged", () => {
  const { home, path } = setup();
  const r = reconcile([{ op: "adopt", path }], undefined, home);
  assert.deepEqual(r.actions, [{ op: "adopt", path }]);
});

test("differs and no entry: replace (backup and overwrite, as before)", () => {
  const { home, path } = setup();
  writeFileSync(path, "mine");
  for (const manifest of [undefined, emptyManifest(new Date())]) {
    assert.equal((reconcile([install(path, true)], manifest, home).actions[0] as { decision: string }).decision, "replace");
  }
});

test("differs and still what pi-setup installed: silent update", () => {
  const { home, path } = setup();
  writeFileSync(path, "old");
  const r = reconcile([install(path, true)], manifestFor(path, home, "old"), home);
  assert.equal((r.actions[0] as { decision: string }).decision, "update");
  assert.deepEqual(r.conflicts, []);
});

test("differs and changed by the user: keep, writing .pi-setup-new only when it is missing or different", () => {
  const { home, path } = setup();
  writeFileSync(path, "mine");
  const m = manifestFor(path, home, "old");
  const first = reconcile([install(path, true)], m, home);
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.conflicts[0].write, true);
  assert.equal(first.conflicts[0].newPath, `${path}.pi-setup-new`);
  writeFileSync(`${path}.pi-setup-new`, "new");
  assert.equal(reconcile([install(path, true)], m, home).conflicts[0].write, false);
  writeFileSync(`${path}.pi-setup-new`, "stale");
  assert.equal(reconcile([install(path, true)], m, home).conflicts[0].write, true);
});

test("user.json merges and the register action are never conflicts", () => {
  const { home } = setup();
  const user = join(home, ".pi/agent/user.json");
  writeFileSync(user, "{}");
  const m = manifestFor(user, home, "something else");
  const actions: Action[] = [
    install(user, true, { merge: "user-json" }),
    { op: "register", path: user, content: want, mode: 0o644, existed: true },
  ];
  const r = reconcile(actions, m, home);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.actions, actions);
});

test("a take turns the keep back into an overwriting install", () => {
  const { home, path } = setup();
  writeFileSync(path, "mine");
  const r = reconcile([install(path, true)], manifestFor(path, home, "old"), home);
  const taken = applyTakes(r.actions, new Set([path]))[0];
  assert.ok(taken.op === "install" && taken.decision === "take" && taken.existed);
  assert.equal(applyTakes(r.actions, new Set())[0].op, "keep");
});
