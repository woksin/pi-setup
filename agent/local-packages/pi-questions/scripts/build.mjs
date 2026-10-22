// prepack: emit plain JavaScript for the CLI and the modules it imports into dist/.
// Node refuses to strip types for files under node_modules, so the installed CLI must be JavaScript.
// Uses node:module stripTypeScriptTypes (no dependencies). The extension stays TypeScript, as pi loads it.
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of readdirSync(join(root, "src"))) {
	if (!file.endsWith(".ts") || file === "extension.ts") continue;
	const code = readFileSync(join(root, "src", file), "utf8");
	const js = stripTypeScriptTypes(code, { mode: "strip" }).replace(/(from\s+["']\.\/[\w-]+)\.ts(["'])/g, "$1.js$2");
	const target = join(out, file.replace(/\.ts$/, ".js"));
	writeFileSync(target, js);
}
chmodSync(join(out, "cli.js"), 0o755);
