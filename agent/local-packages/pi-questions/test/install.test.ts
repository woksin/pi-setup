import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tempDir } from "./helpers.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));

// Node refuses to strip types under node_modules, so the installed CLI must be shipped as JavaScript.
test("the packed tarball installs and its CLI runs from node_modules/.bin", t => {
	const tmp = tempDir(t);
	const dest = join(tmp, "pack");
	const prefix = join(tmp, "install");
	mkdirSync(dest);
	mkdirSync(prefix);
	writeFileSync(join(prefix, "package.json"), "{}");
	const packed = spawnSync("npm", ["pack", "--pack-destination", dest, "--silent"], { cwd: pkg, encoding: "utf8" });
	assert.equal(packed.status, 0, packed.stderr);
	const tgz = join(dest, readdirSync(dest).find(f => f.endsWith(".tgz"))!);
	const installed = spawnSync("npm", ["install", tgz, "--prefix", prefix, "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"], { encoding: "utf8" });
	assert.equal(installed.status, 0, installed.stderr);
	const bin = join(prefix, "node_modules", ".bin", "pi-questions");
	assert.ok(existsSync(bin));
	const home = join(tmp, "qhome");
	const env = { ...process.env, PI_QUESTIONS_HOME: home, PI_SESSION_ID: "installed-1" };
	const list = spawnSync(bin, ["list"], { env, cwd: tmp, encoding: "utf8" });
	assert.equal(list.status, 0, list.stderr);
	assert.match(list.stdout, /No matching items/);
	const ask = spawnSync(bin, ["ask", "--kind", "fyi", "--title", "From the installed package"], { env, cwd: tmp, encoding: "utf8" });
	assert.equal(ask.status, 0, ask.stderr);
	assert.equal(spawnSync(bin, ["wait", "Q-1"], { env, cwd: tmp, encoding: "utf8" }).status, 1);
	assert.match(spawnSync(bin, ["list"], { env, cwd: tmp, encoding: "utf8" }).stdout, /From the installed package/);
});
