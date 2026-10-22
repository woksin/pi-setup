import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir, base, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) walk(full, rel, out);
    else out.push(rel);
  }
}

/** sha256 over the sorted relative paths and bytes of everything the bundle is built from. */
export function sourceHash(root) {
  const files = [];
  walk(join(root, "src"), "src", files);
  files.push("scripts/build.mjs", "scripts/source-hash.mjs", "package-lock.json");
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
