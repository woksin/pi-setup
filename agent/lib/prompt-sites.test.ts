/**
 * Enumerates prompt call sites in the LOADED agent code (extensions, early-extensions, lib and the
 * local packages listed in settings.json) and fails on any direct, unbounded prompt that is not
 * allowlisted. Hook/guard prompts must go through guardSelect/boundedSelect (lib/orchestration.ts).
 *
 * Matching is per call, not per line: every prompt call occurrence is extracted as its full
 * (whitespace-normalised) call expression and must match exactly one allowlist entry's start/end; each
 * entry covers one occurrence only, so an extra call on the same line or a second call in the same
 * function is reported.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { localPackageDirs } from "./code-change-notice.ts";

const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT_SRC = String.raw`\bui\??\.(?:select|confirm|input|editor|custom|waitForInput)\s*\(|process\.stdin|\bwaitForInput\s*\(`;

interface Allowed { file: string; start: string; end: string; reason: string }
interface Site { file: string; n: number; call: string }

const ALLOWLIST: Allowed[] = [
	{ file: "lib/orchestration.ts", start: "ui.select(title, options, { signal: controller.signal, timeout: ms })", end: "ui.select(title, options, { signal: controller.signal, timeout: ms })",
		reason: "the bounded helper itself: pi timeout + abort signal + independent timer" },
	{ file: "extensions/lane-policy.ts", start: 'ui.confirm("Change lane policy?"', end: "{ timeout: 30000 })",
		reason: "operator-typed /lane-policy command handler (TUI only, never a tool_call/hook path); pi dialog timeout of 30 s with default decline" },
	{ file: "extensions/ai-work-lifecycle.ts", start: 'ui.confirm("Finish task and clean disposable outputs?"', end: "Fresh safety checks still apply.`)",
		reason: "operator-typed /ai-work finish command handler; user is present; not reachable from a tool_call/hook" },
	{ file: "extensions/ai-work-lifecycle.ts", start: 'ui.confirm("Purge completed disposable artifacts?"', end: "all safety checks run again.`)",
		reason: "operator-typed /ai-work apply command handler; user is present; not reachable from a tool_call/hook" },
];

/** Index just past the ")" closing the "(" at `open`, skipping string/template contents. */
function closeParen(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
		} else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i + 1;
	}
	return src.length;
}

/** Every prompt call occurrence in `src` (comment lines skipped), including nested ones. */
export function findSites(file: string, src: string): Site[] {
	const out: Site[] = [];
	const re = new RegExp(PROMPT_SRC, "g");
	for (let m = re.exec(src); m; m = re.exec(src)) {
		const lineStart = src.lastIndexOf("\n", m.index) + 1;
		if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, m.index + 1))) continue;
		const text = m[0].endsWith("(") ? src.slice(m.index, closeParen(src, m.index + m[0].length - 1)) : m[0];
		out.push({ file, n: src.slice(0, m.index).split("\n").length, call: text.replace(/\s+/g, " ").trim() });
	}
	return out;
}

/** The whole call expression must begin and end as allowed; any other prompt call inside it is its own site. */
function matches(a: Allowed, call: string): boolean {
	return call.startsWith(a.start) && call.endsWith(a.end);
}

/** Sites not covered by an allowlist entry; each entry covers at most one occurrence. */
export function unallowed(sites: Site[], allowlist: Allowed[]): Site[] {
	const used = new Set<Allowed>();
	return sites.filter(s => {
		const hit = allowlist.find(a => !used.has(a) && a.file === s.file && matches(a, s.call));
		if (hit) used.add(hit);
		return !hit;
	});
}

function sourceFiles(dir: string, out: string[] = []): string[] {
	let names: string[] = [];
	try { names = readdirSync(dir); } catch { return out; }
	for (const name of names) {
		if (name === "node_modules" || name === ".git" || name === "dist") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sourceFiles(path, out);
		else if (/\.(ts|js|mjs)$/.test(name) && !/\.test\.(ts|js|mjs)$/.test(name) && !name.includes(".bak")) out.push(path);
	}
	return out;
}

async function loadedSources(): Promise<string[]> {
	const roots = [join(AGENT_DIR, "extensions"), join(AGENT_DIR, "early-extensions"), join(AGENT_DIR, "lib"),
		...(await localPackageDirs(AGENT_DIR)).map(d => join(d, "src"))];
	return roots.flatMap(r => sourceFiles(r));
}

async function allSites(): Promise<Site[]> {
	return (await loadedSources()).flatMap(p => findSites(relative(AGENT_DIR, p), readFileSync(p, "utf8")));
}

test("scan covers the loaded sources, including the guards", async () => {
	const files = (await loadedSources()).map(f => relative(AGENT_DIR, f));
	for (const must of ["extensions/phase-priority.ts", "extensions/cratis-cli-guard.ts", "extensions/lane-policy.ts", "lib/orchestration.ts"]) assert.ok(files.includes(must), `${must} not scanned`);
});

test("every prompt call is allowlisted by call expression (start and end); none are unbounded by accident", async () => {
	const bad = unallowed(await allSites(), ALLOWLIST).map(s => `${s.file}:${s.n}: ${s.call.slice(0, 120)}`);
	assert.deepEqual(bad, [], "route these through guardSelect/boundedSelect (lib/orchestration.ts) or allowlist with a reason");
});

test("the allowlist has no stale entries and every entry has a reason", async () => {
	const sites = await allSites();
	for (const a of ALLOWLIST) {
		assert.ok(a.reason.length > 20, `${a.file}: reason required`);
		assert.ok(sites.some(s => s.file === a.file && matches(a, s.call)), `stale allowlist entry: ${a.file} ${a.start.slice(0, 80)}`);
	}
});

test("hook guards use the bounded helper", () => {
	for (const file of ["extensions/phase-priority.ts", "extensions/cratis-cli-guard.ts"]) {
		assert.match(readFileSync(join(AGENT_DIR, file), "utf8"), /guardSelect\(/, `${file} must prompt via guardSelect`);
	}
});

test("regression: an allowed call does not exempt an extra call on the same line or in the same function", () => {
	const allowed: Allowed[] = [{ file: "x.ts", start: 'ui.confirm("ok?"', end: '"ok?")', reason: "regression fixture reason text" }];
	const sameLine = 'async function h(ctx) { await ctx.ui.confirm("ok?"); await ctx.ui.input("unbounded"); }';
	assert.deepEqual(unallowed(findSites("x.ts", sameLine), allowed).map(s => s.call), ['ctx.ui.input("unbounded")'.replace("ctx.", "")]);
	const twice = 'async function h(ctx) {\n await ctx.ui.confirm("ok?");\n await ctx.ui.confirm("ok?");\n}';
	assert.equal(unallowed(findSites("x.ts", twice), allowed).length, 1);
	const nested = 'await ctx.ui.confirm("ok?", await ctx.ui.input("x"))';
	assert.equal(unallowed(findSites("x.ts", nested), allowed).length, 2, "different full call text, plus the nested call");
	assert.equal(unallowed(findSites("x.ts", 'await ctx.ui.confirm("ok?");'), allowed).length, 0);
	assert.equal(unallowed(findSites("y.ts", 'await ctx.ui.confirm("ok?");'), allowed).length, 1, "file must match");
});

test("the detector flags unbounded calls and ignores non-ui confirm", () => {
	for (const bad of ["await ctx.ui.select('t', ['a'])", "ui?.input('x')", "const x = await ctx.ui.custom(() => c)", "process.stdin.on('data', f)"]) assert.equal(findSites("f.ts", bad).length, 1, bad);
	assert.equal(findSites("f.ts", "delivery.confirm(id)").length, 0);
	assert.equal(findSites("f.ts", "// ctx.ui.select('t')").length, 0);
});
