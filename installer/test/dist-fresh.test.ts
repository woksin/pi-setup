import { strict as assert } from "node:assert";
import { cpSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sourceHash } from "../scripts/source-hash.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STALE = "installer/dist is stale: run npm --prefix installer run build";

function bannerHash(): string | undefined {
  const text = readFileSync(join(root, "dist/pi-setup.mjs"), "utf8");
  return /^\/\/ pi-setup-source-sha256: ([0-9a-f]{64})$/m.exec(text)?.[1];
}

test("dist banner matches the source hash", () => {
  assert.equal(bannerHash(), sourceHash(root), STALE);
});

test("a source change without a rebuild is reported as stale (h)", () => {
  const copy = mkdtempSync(join(tmpdir(), "pisetup-stale."));
  try {
    for (const entry of ["src", "scripts", "package-lock.json"]) cpSync(join(root, entry), join(copy, entry), { recursive: true });
    assert.equal(sourceHash(copy), sourceHash(root));
    appendFileSync(join(copy, "src/cli.ts"), "\n// changed\n");
    assert.notEqual(sourceHash(copy), bannerHash(), STALE);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
