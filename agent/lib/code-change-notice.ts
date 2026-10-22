/**
 * code-change-notice — cheap async fingerprint (path, mtime, size) of the code a session loads, so a
 * running session can tell when it changed on disk after start. Never reads file contents, never
 * follows symlinks (lstat), never walks beyond MAX_VISITED entries, never throws.
 *
 * Covered: top-level *.ts/*.js directly in extensions/, early-extensions/ and lib/ (no recursion,
 * *.test.* excluded); per local package in settings.json: package.json plus src/ recursively
 * (excluding node_modules, .git, dist, .ai-work and test dirs).
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const CODE_CHANGE_INTERVAL_MS = 5 * 60_000;
export const CODE_CHANGE_STATUS = "code changed since load: /reload when idle";
export const CODE_SCAN_CAPPED_STATUS = "code change scan capped: /reload when idle if you changed code";
export const MAX_VISITED = 2000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".ai-work", "test", "tests", "__tests__"]);
const TOP_LEVEL = /\.(ts|js)$/;

export type Fingerprint = Map<string, string>;
export interface Scan { files: Fingerprint; capped: boolean; visited: number }

class Budget { visited = 0; capped = false;
	take(): boolean { if (this.visited >= MAX_VISITED) { this.capped = true; return false; } this.visited++; return true; } }

async function addFile(path: string, out: Fingerprint, budget: Budget): Promise<void> {
	if (!budget.take()) return;
	try {
		const info = await lstat(path);
		if (info.isFile()) out.set(path, `${Math.trunc(info.mtimeMs)}:${info.size}`);
	} catch { /* vanished */ }
}

async function topLevel(dir: string, out: Fingerprint, budget: Budget): Promise<void> {
	let names: string[];
	try { names = (await readdir(dir)).sort(); } catch { return; }
	for (const name of names) {
		if (budget.capped) return;
		if (!TOP_LEVEL.test(name) || /\.test\./.test(name) || name.includes(".bak")) continue;
		await addFile(join(dir, name), out, budget);
	}
}

async function recurse(dir: string, out: Fingerprint, budget: Budget): Promise<void> {
	let names: string[];
	try { names = (await readdir(dir)).sort(); } catch { return; }
	for (const name of names) {
		if (budget.capped) return;
		if (SKIP_DIRS.has(name) || name.includes(".bak")) continue;
		const path = join(dir, name);
		if (!budget.take()) return;
		try {
			const info = await lstat(path); // lstat: symlinks are skipped, never followed
			if (info.isDirectory()) await recurse(path, out, budget);
			else if (info.isFile() && /\.(ts|js|mjs|json)$/.test(name) && !/\.test\./.test(name)) out.set(path, `${Math.trunc(info.mtimeMs)}:${info.size}`);
		} catch { /* vanished */ }
	}
}

/** Local package directories (./local-packages/...) listed in settings.json "packages". */
export async function localPackageDirs(agentDir: string): Promise<string[]> {
	try {
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
		const packages: unknown[] = Array.isArray(settings.packages) ? settings.packages : [];
		return packages.filter((p): p is string => typeof p === "string" && p.startsWith("./local-packages/")).map(p => resolve(agentDir, p));
	} catch { return []; }
}

export async function fingerprint(agentDir: string): Promise<Scan> {
	const files: Fingerprint = new Map();
	const budget = new Budget();
	for (const sub of ["extensions", "early-extensions", "lib"]) await topLevel(join(agentDir, sub), files, budget);
	for (const dir of await localPackageDirs(agentDir)) {
		await addFile(join(dir, "package.json"), files, budget);
		await recurse(join(dir, "src"), files, budget);
	}
	return { files, capped: budget.capped, visited: budget.visited };
}

/** Paths added, removed or modified between two fingerprints (sorted). */
export function changedPaths(before: Fingerprint, after: Fingerprint): string[] {
	const changed = new Set<string>();
	for (const [path, sig] of after) if (before.get(path) !== sig) changed.add(path);
	for (const path of before.keys()) if (!after.has(path)) changed.add(path);
	return [...changed].sort();
}
