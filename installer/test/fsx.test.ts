import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listFiles } from "../src/fsx.ts";
import { tempDir } from "./helpers/home.ts";

test("listFiles skips Python caches, OS clutter, node_modules and .pi-setup-new copies", () => {
  const dir = tempDir("fsx-");
  for (const sub of ["bin/__pycache__", "lib/node_modules/x", "lib/nested"]) mkdirSync(join(dir, sub), { recursive: true });
  for (const file of ["bin/tool", "bin/__pycache__/tool.cpython-314.pyc", "bin/stray.pyc", "bin/.DS_Store",
    "lib/a.ts", "lib/a.ts.pi-setup-new", "lib/node_modules/x/index.js", "lib/nested/b.mjs"]) {
    writeFileSync(join(dir, file), "x");
  }
  assert.deepEqual(listFiles(dir), ["bin/tool", "lib/a.ts", "lib/nested/b.mjs"]);
});

test("listFiles skips .ai-work at every depth without removing private sentinels", () => {
  const dir = tempDir("fsx-workarea-");
  const privateFiles = [".ai-work/sentinel", "lib/.ai-work/nested/sentinel", "lib/nested/.ai-work/sentinel"];
  for (const sub of [".ai-work", "lib/.ai-work/nested", "lib/nested/.ai-work", "lib/.ai-work-notes"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  for (const file of privateFiles) writeFileSync(join(dir, file), "private workarea sentinel");
  writeFileSync(join(dir, "lib/nested/public.ts"), "public");
  writeFileSync(join(dir, "lib/.ai-work-notes/public.md"), "public");

  assert.deepEqual(listFiles(dir), ["lib/.ai-work-notes/public.md", "lib/nested/public.ts"]);
  for (const file of privateFiles) assert.equal(readFileSync(join(dir, file), "utf8"), "private workarea sentinel");
});
