import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_VISITED, changedPaths, fingerprint, localPackageDirs } from "./code-change-notice.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "code-change-"));
	for (const d of ["extensions", "early-extensions", "lib", "extensions/deep", "local-packages/pi-x/src/sub", "local-packages/pi-x/src/test", "local-packages/pi-x/node_modules/dep", "local-packages/pi-x/test", "local-packages/pi-x/.ai-work", "local-packages/other/src"]) mkdirSync(join(root, d), { recursive: true });
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: ["npm:foo", "./local-packages/pi-x", "./early-extensions/a.ts"] }));
	const w = (p: string, c = "x") => writeFileSync(join(root, p), c);
	w("extensions/a.ts", "a"); w("extensions/deep/nested.ts"); w("extensions/notes.md"); w("lib/b.ts", "b"); w("lib/b.test.ts");
	w("local-packages/pi-x/package.json", "{}"); w("local-packages/pi-x/README.md"); w("local-packages/pi-x/src/c.ts", "c"); w("local-packages/pi-x/src/sub/e.ts");
	w("local-packages/pi-x/src/test/t.ts"); w("local-packages/pi-x/test/t.ts"); w("local-packages/pi-x/node_modules/dep/i.js"); w("local-packages/pi-x/.ai-work/x.json");
	w("local-packages/other/src/d.ts");
	return root;
}
const rel = (root: string, paths: Iterable<string>) => [...paths].map(p => p.slice(root.length + 1)).sort();

test("covers only top-level extension/lib sources and package.json + src of listed packages", async () => {
	const root = setup();
	try {
		assert.deepEqual(await localPackageDirs(root), [join(root, "local-packages/pi-x")]);
		const scan = await fingerprint(root);
		assert.equal(scan.capped, false);
		assert.deepEqual(rel(root, scan.files.keys()), ["extensions/a.ts", "lib/b.ts", "local-packages/pi-x/package.json", "local-packages/pi-x/src/c.ts", "local-packages/pi-x/src/sub/e.ts"]);
	} finally { rmSync(root, { recursive: true }); }
});

test("symlinks are not followed or fingerprinted", async () => {
	const root = setup();
	try {
		mkdirSync(join(root, "outside"));
		writeFileSync(join(root, "outside/z.ts"), "z");
		symlinkSync(join(root, "outside"), join(root, "local-packages/pi-x/src/linked"));
		symlinkSync(join(root, "outside/z.ts"), join(root, "extensions/link.ts"));
		const keys = rel(root, (await fingerprint(root)).files.keys());
		assert.ok(!keys.some(k => k.includes("link") || k.includes("z.ts")), keys.join());
	} finally { rmSync(root, { recursive: true }); }
});

test("modify, add and remove are detected; unrelated files and backups are not", async () => {
	const root = setup();
	try {
		const before = (await fingerprint(root)).files;
		assert.deepEqual(changedPaths(before, (await fingerprint(root)).files), []);
		writeFileSync(join(root, "lib/b.ts.bak-1"), "backup");
		writeFileSync(join(root, "extensions/notes.md"), "changed");
		writeFileSync(join(root, "local-packages/pi-x/.ai-work/x.json"), "changed");
		assert.deepEqual(changedPaths(before, (await fingerprint(root)).files), []);
		writeFileSync(join(root, "extensions/a.ts"), "a-longer");
		writeFileSync(join(root, "extensions/new.ts"), "n");
		unlinkSync(join(root, "local-packages/pi-x/src/c.ts"));
		assert.deepEqual(rel(root, changedPaths(before, (await fingerprint(root)).files)), ["extensions/a.ts", "extensions/new.ts", "local-packages/pi-x/src/c.ts"]);
	} finally { rmSync(root, { recursive: true }); }
});

test("same-size rewrite is detected through mtime; missing dirs never throw", async () => {
	const root = setup();
	try {
		const before = (await fingerprint(root)).files;
		writeFileSync(join(root, "lib/b.ts"), "z");
		utimesSync(join(root, "lib/b.ts"), new Date(), new Date(Date.now() + 5000));
		assert.deepEqual(rel(root, changedPaths(before, (await fingerprint(root)).files)), ["lib/b.ts"]);
		assert.equal((await fingerprint(join(root, "nonexistent"))).files.size, 0);
	} finally { rmSync(root, { recursive: true }); }
});

test("traversal is hard-capped and reported, not walked further", async () => {
	const root = setup();
	try {
		for (let i = 0; i < MAX_VISITED + 50; i++) writeFileSync(join(root, "local-packages/pi-x/src/sub", `f${i}.ts`), "x");
		const scan = await fingerprint(root);
		assert.equal(scan.capped, true);
		assert.ok(scan.visited <= MAX_VISITED);
	} finally { rmSync(root, { recursive: true }); }
});
