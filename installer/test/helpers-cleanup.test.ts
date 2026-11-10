import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const helper = join(dirname(fileURLToPath(import.meta.url)), "helpers", "home.ts");

function run(body: string): { status: number | null; paths: string[] } {
  const script = `import { tempDir, sandbox } from ${JSON.stringify(helper)};
const t = tempDir("cleanup-probe"); const s = sandbox(); console.log(t); console.log(s.root); ${body}`;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { encoding: "utf8" });
  return { status: r.status, paths: r.stdout.trim().split("\n").filter(Boolean) };
}

test("temp dirs from tempDir() and sandbox() are removed when the process exits normally", () => {
  const r = run("");
  assert.equal(r.status, 0); assert.equal(r.paths.length, 2);
  for (const p of r.paths) assert.equal(existsSync(p), false, `${p} leaked`);
});
test("temp dirs are removed when the process fails", () => {
  const r = run("process.exitCode = 3;");
  assert.equal(r.status, 3);
  for (const p of r.paths) assert.equal(existsSync(p), false, `${p} leaked`);
});
