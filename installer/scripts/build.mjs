import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { sourceHash } from "./source-hash.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist/pi-setup.mjs");

await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
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
