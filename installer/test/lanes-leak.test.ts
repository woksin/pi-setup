import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./helpers/home.ts";
function walk(path: string): string[] {
  return statSync(path).isDirectory() ? readdirSync(path).flatMap((n) => walk(join(path, n))) : [path];
}
test("shipped lanes code, templates and bundle contain no author or machine references", () => {
  for (const rel of ["installer/src/lanes", "installer/lanes/templates", "installer/dist/lanes.mjs"]) {
    for (const path of walk(join(REPO, rel))) {
      const text = readFileSync(path, "utf8");
      assert.doesNotMatch(text, /\/Volumes|woksin|einari|cratis\/|\/Users\/|\/home\//i, path);
      if (rel.includes("templates")) assert.doesNotMatch(text, /\{\{(?:GITHUB_USER|REPOS_ROOT)\}\}/, path);
    }
  }
});
