import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { sourceHash } from "./source-hash.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const [entry, output] of [["src/cli.ts", "pi-setup.mjs"], ["src/lanes/cli.ts", "lanes.mjs"]]) {
  const outfile = join(root, "dist", output);

  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    legalComments: "eof",
    logLevel: "warning",
    banner: { js: `#!/usr/bin/env node\n// pi-setup-source-sha256: ${sourceHash(root)}` },
  });
  chmodSync(outfile, 0o755);
}
