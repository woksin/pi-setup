import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
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
