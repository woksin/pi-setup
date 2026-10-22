import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { BackupRun, listBackups, prune } from "../src/backups.ts";
import { tempDir } from "./helpers/home.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function setup() {
  const home = tempDir("pisetup-backups");
  dirs.push(home);
  const piDir = join(home, ".pi/agent");
  mkdirSync(piDir, { recursive: true });
  return { home, piDir, base: join(piDir, ".pi-setup/backups") };
}
function runDir(base: string, name: string, files: string[]): void {
  for (const f of files) {
    mkdirSync(join(base, name, f, ".."), { recursive: true });
    writeFileSync(join(base, name, f), f);
  }
}

test("backup copies below the run folder, and a stamp collision gets -2", () => {
  const { home, piDir, base } = setup();
  writeFileSync(join(piDir, "a.md"), "A");
  writeFileSync(join(home, "outside.txt"), "O");
  const now = new Date(2026, 0, 2, 3, 4, 5);
  mkdirSync(join(base, "20260102-030405"), { recursive: true });
  const run = new BackupRun(piDir, home, now);
  assert.equal(run.backup(join(piDir, "a.md")), "20260102-030405-2/a.md");
  assert.equal(run.backup(join(home, "outside.txt")), "20260102-030405-2/_home/outside.txt");
  assert.equal(run.backup(join(piDir, "a.md")), "20260102-030405-2/a.md");
  assert.ok(existsSync(join(base, "20260102-030405-2/a.md")));
});

test("prune keeps the newest N; a pinned file survives in an old folder with its unpinned siblings gone", () => {
  const { piDir, base } = setup();
  const names = Array.from({ length: 12 }, (_, i) => `202601${String(i + 1).padStart(2, "0")}-000000`);
  names.forEach((n) => runDir(base, n, ["x.md", "sub/y.md"]));
  const pinned = new Set([`${names[0]}/sub/y.md`]);
  const removed = prune(piDir, 10, pinned, false);
  assert.equal(removed.length, 2, removed.join("\n")); // the unpinned folder, and x.md in the pinned one
  assert.ok(!existsSync(join(base, names[1])));
  assert.ok(existsSync(join(base, names[0], "sub/y.md")));
  assert.ok(!existsSync(join(base, names[0], "x.md")));
  assert.equal(readdirSync(base).length, 11);
  assert.equal(listBackups(piDir, pinned).find((b) => b.name === names[0])?.pinned, true);
});

test("keep 0 removes everything unpinned; dry-run deletes nothing", () => {
  const { piDir, base } = setup();
  runDir(base, "20260101-000000", ["a"]);
  runDir(base, "20260102-000000", ["a"]);
  runDir(base, "20260102-000000-2", ["a"]);
  assert.deepEqual(listBackups(piDir, new Set()).map((b) => b.name), ["20260102-000000-2", "20260102-000000", "20260101-000000"]);
  assert.equal(prune(piDir, 0, new Set(), true).length, 3);
  assert.equal(readdirSync(base).length, 3);
  prune(piDir, 0, new Set(), false);
  assert.equal(readdirSync(base).length, 0);
});

test("prune never touches anything that is not a run folder", () => {
  const { piDir, base } = setup();
  runDir(base, "notes", ["keep.txt"]);
  runDir(base, "20260101-000000", ["a"]);
  prune(piDir, 0, new Set(), false);
  assert.ok(existsSync(join(base, "notes/keep.txt")));
  assert.ok(existsSync(join(piDir, "..", "agent")));
});
