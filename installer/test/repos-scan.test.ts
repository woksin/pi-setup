import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanRoots } from "../src/repos-scan.ts";

function repo(root: string, name: string, origin?: string): void {
  mkdirSync(join(root, name, ".git"), { recursive: true });
  if (origin) writeFileSync(join(root, name, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
}

test("scores checkouts, adds a point for matching owners, skips noise and ranks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pisetup-scan."));
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    repo(a, "one", "git@github.com:einari/one.git");
    repo(a, "two", "https://github.com/Cratis/two");
    repo(a, "three", "https://github.com/other/three");
    mkdirSync(join(a, "node_modules", "x", ".git"), { recursive: true });
    repo(b, "solo");
    writeFileSync(join(b, "file"), "");
    mkdirSync(join(b, "wt"));
    writeFileSync(join(b, "wt", ".git"), "gitdir: /elsewhere");
    const result = scanRoots([b, a, a, join(dir, "missing")], ["einari", "cratis"], { now: () => 0 });
    assert.deepEqual(result, [{ path: a, score: 5 }, { path: b, score: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired deadline stops the scan", () => {
  let t = 0;
  const result = scanRoots([tmpdir()], [], { now: () => (t += 5000), deadlineMs: 10 });
  assert.deepEqual(result, []);
});
