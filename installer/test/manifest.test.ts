import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  emptyManifest, fromHomeRel, manifestPath, validateManifest, symlinkTarget, pinnedBackups, readManifest, recordArrayAdd, recordSet, saveIfChanged,
} from "../src/manifest.ts";
import { SetupError } from "../src/types.ts";
import { tempDir } from "./helpers/home.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const home = () => {
  const h = tempDir("pisetup-manifest");
  dirs.push(h);
  return h;
};

test("path validation rejects absolute, .., empty and protected paths", () => {
  const h = "/tmp/h";
  for (const bad of ["", "/etc/hosts", "../x", "a/../b", "a//b", "./a", ".pi/agent/auth.json", ".pi/agent/auth.json.lock",
    ".pi/agent/models-store.json", ".pi/agent/guards.json", ".pi/agent/accounts/x", ".pi/agent/sessions/s.jsonl", ".pi/agent/jobs/j",
    ".pi/agent/relaunch/r", ".pi/agent/context-budget/c", ".pi/agent/pi-phase/state/s", ".pi/agent/lane-policy/policy.json",
    ".pi/agent/npm/node_modules/x/y", ".pi/agent/.pi-setup/manifest.json", ".pi/agent/.pi-setup"]) {
    assert.throws(() => fromHomeRel(h, bad), SetupError, JSON.stringify(bad));
  }
  assert.equal(fromHomeRel(h, ".pi/agent/context-budget.json"), "/tmp/h/.pi/agent/context-budget.json");
  assert.equal(fromHomeRel(h, ".pi/agent/agents/a.md"), "/tmp/h/.pi/agent/agents/a.md");
});

test("a corrupt manifest is a SetupError naming the file", () => {
  const h = home();
  const pi = join(h, ".pi/agent");
  mkdirSync(join(pi, ".pi-setup"), { recursive: true });
  writeFileSync(manifestPath(pi), "{ nope");
  assert.throws(() => readManifest(pi), (e: Error) => e instanceof SetupError && e.message.includes(manifestPath(pi)));
  writeFileSync(manifestPath(pi), '{"version":2}');
  assert.throws(() => readManifest(pi), SetupError);
  rmSync(manifestPath(pi));
  assert.equal(readManifest(pi), undefined);
});

test("save and load round-trip; saveIfChanged ignores updatedAt", () => {
  const h = home();
  const pi = join(h, ".pi/agent");
  const m = emptyManifest(new Date(2026, 0, 1));
  m.files["a"] = { sha256: "x", mode: 420, source: { release: null, commit: null }, origin: "new" };
  assert.equal(saveIfChanged(pi, undefined, m, new Date(2026, 0, 2)), true);
  const loaded = readManifest(pi)!;
  assert.deepEqual(loaded, m);
  const before = readFileSync(manifestPath(pi));
  const next = structuredClone(loaded);
  assert.equal(saveIfChanged(pi, loaded, next, new Date(2027, 0, 1)), false);
  assert.ok(readFileSync(manifestPath(pi)).equals(before));
  next.dirs.push("d");
  assert.equal(saveIfChanged(pi, loaded, next, new Date(2027, 0, 1)), true);
});

test("recording a set twice keeps the first before and updates after; array-add is recorded once", () => {
  const entry = { created: false, sha256After: "", ops: [] };
  recordSet(entry, { op: "set", key: "githubUser", before: { present: true, value: "old" }, after: "a" });
  recordSet(entry, { op: "set", key: "githubUser", before: { present: true, value: "a" }, after: "b" });
  assert.deepEqual(entry.ops, [{ op: "set", key: "githubUser", before: { present: true, value: "old" }, after: "b" }]);
  recordArrayAdd(entry, { op: "array-add", key: "packages", value: "p", keyCreated: true });
  recordArrayAdd(entry, { op: "array-add", key: "packages", value: "p", keyCreated: false });
  assert.equal(entry.ops.length, 2);
});

test("pinned backups cover file and json entries", () => {
  const m = emptyManifest(new Date());
  m.files["a"] = { sha256: "x", mode: 1, source: { release: null, commit: null }, origin: "replaced", backup: "t/a" };
  m.json["j"] = { created: false, backup: "t/j", sha256After: "", ops: [] };
  assert.deepEqual([...pinnedBackups(m)].sort(), ["t/a", "t/j"]);
});

test("symlink targets are metadata: protected targets accepted, link paths still strict", () => {
  const h = home(); const target = ".pi/agent/npm/node_modules/@woksin/pi-orch/bin/orch";
  const m = emptyManifest(new Date()); m.symlinks[".local/bin/orch"] = { target };
  assert.doesNotThrow(() => validateManifest(h, m)); assert.equal(symlinkTarget(h, target), join(h, target));
  assert.throws(() => fromHomeRel(h, target), SetupError);
  for (const path of [target, ".pi/agent/auth.json", "/absolute", "../escape", ""]) {
    const bad = emptyManifest(new Date()); bad.symlinks[path] = { target: ".local/share/tool" };
    assert.throws(() => validateManifest(h, bad), SetupError, path);
  }
  for (const target of ["", "/absolute", "../escape", "a/../b", "a//b"]) {
    const bad = emptyManifest(new Date()); bad.symlinks[".local/bin/tool"] = { target };
    assert.throws(() => validateManifest(h, bad), SetupError, target);
  }
  const files = emptyManifest(new Date());
  files.files[target] = { sha256: "x", mode: 420, source: { release: null, commit: null }, origin: "new" };
  assert.throws(() => validateManifest(h, files), SetupError);
});
