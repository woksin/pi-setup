import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DISABLED, SessionRoles, capResult, capText, countLines, loadConfig, looksLikeTestOrBuild, offloadDirs, parseConfig, logError, pruneToolOut, pruneOncePerHour, resetPruneGuard, errorLogPath, scopeAllows, truncate,
} from "./output-cap.ts";
import extension from "../extensions/output-cap.ts";

const PK = "PRIVATE" + " KEY";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pi-output-cap-")); });
afterEach(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });

const lines = (n: number, f = (i: number) => `line ${i} ${"x".repeat(40)}`) => Array.from({ length: n }, (_, i) => f(i)).join("\n");
const text = (t: string) => [{ type: "text", text: t }];

test("results under the limit, edit/write and images are untouched", () => {
	assert.equal(capText("bash", text("short"), 100), undefined);
	assert.equal(capText("bash", text("x".repeat(100)), 100), undefined);
	assert.equal(capText("edit", text("x".repeat(500)), 100), undefined);
	assert.equal(capText("write", text("x".repeat(500)), 100), undefined);
	assert.equal(capText("read", [...text("x".repeat(500)), { type: "image", data: "", mimeType: "image/png" }], 100), undefined);
	assert.equal(capText("read", text("x".repeat(101)), 100), "x".repeat(101));
	assert.equal(capResult({ toolName: "edit", toolCallId: "c", input: {}, content: text("y".repeat(50000)) }, 12000, [dir]), undefined);
});

test("truncation keeps ~60% head, ~40% tail, elision note and marker", () => {
	const full = lines(2000);
	const out = truncate(full, 12000, { keepFailures: false, path: "/p/c.txt" });
	const [head] = out.split("\n[... ");
	assert.ok(full.startsWith(head));
	assert.ok(head.length <= 7200 && head.length > 6000, `head ${head.length}`);
	const tail = out.slice(out.indexOf("lines elided ...]\n") + "lines elided ...]\n".length, out.lastIndexOf("\n[full output"));
	assert.ok(full.endsWith(tail));
	assert.ok(tail.length <= 4900 && tail.length > 3800, `tail ${tail.length}`);
	assert.match(out, /\[\.\.\. \d+ lines elided \.\.\.\]/);
	assert.ok(out.endsWith(`[full output: /p/c.txt, 2000 lines, ${full.length} chars; use read with offset/limit or grep]`));
	assert.ok(out.length < 12000 + 300);
	assert.ok(!head.endsWith("x") || head.split("\n").every(l => /^line \d+ x{40}$/.test(l)), "head is cut on a line boundary");
});

test("failure lines from the elided middle are kept for test/build output, within ~2k chars", () => {
	const full = lines(3000, i => (i === 1500 ? "  Failed Specs.when_x.should_y [12 ms]" : i === 1600 ? "error CS1002: ; expected" : i > 1700 && i < 1800 ? `FAIL row ${i} ${"z".repeat(60)}` : `ok ${i} ${"x".repeat(40)}`));
	const out = truncate(full, 12000, { keepFailures: true, path: "/p/x.txt" });
	assert.match(out, /failure-like lines from the elided part/);
	assert.match(out, /Failed Specs\.when_x\.should_y/);
	assert.match(out, /error CS1002/);
	const kept = out.slice(out.indexOf("[failure-like"), out.indexOf("[... end of kept lines ...]"));
	assert.ok(kept.length <= 2100, `kept ${kept.length}`);
	assert.ok(out.length < 12000 + 400, `total ${out.length}`);
	const plain = truncate(full, 12000, { keepFailures: false, path: "/p/x.txt" });
	assert.doesNotMatch(plain, /failure-like/);
});

test("test/build detection only for bash", () => {
	assert.ok(looksLikeTestOrBuild("bash", { command: "dotnet test Specs.csproj" }, "..."));
	assert.ok(looksLikeTestOrBuild("bash", { command: "./run.sh" }, "Build FAILED.\n"));
	assert.ok(!looksLikeTestOrBuild("bash", { command: "cat notes.md" }, "hello"));
	assert.ok(!looksLikeTestOrBuild("read", { path: "x" }, "Build FAILED."));
});

test("capResult writes the full output and points the marker at it; ranged reads are capped too", () => {
	const full = lines(1000);
	const content = capResult({ toolName: "read", toolCallId: "toolu_01/a:b", input: { path: "f", offset: 1, limit: 1000 }, content: text(full) }, 8000, [join(dir, "s1")]);
	assert.ok(content);
	const path = join(dir, "s1", "toolu_01_a_b.txt");
	assert.equal(readFileSync(path, "utf8"), full);
	assert.ok(content[0].text.includes(`[full output: ${path}, 1000 lines, ${full.length} chars;`));
	assert.ok(content[0].text.length < 8300);
});

test("offloads and truncates masked full text, including env values in the elided middle", () => {
	const value = "Pr0dMongo!pass";
	const full = `{"name":"MONGODB_PASSWORD","value":"${value}"}\n` + lines(1000, i => i === 500
		? `{"value":"${value}","name":"Chronicle__ClientSecret"}` : `ok ${i} ${"x".repeat(40)}`)
		+ `\n-----BEGIN ${PK}-----\nfixture-material\n-----END ${PK}-----\n`;
	const event = { toolName: "read", toolCallId: "masked", input: {}, content: text(full) };
	const content = capResult(event, 12000, [dir])!;
	const saved = readFileSync(join(dir, "masked.txt"), "utf8");
	assert.equal(saved.match(/\[REDACTED:env-value\]/g)?.length, 2);
	assert.match(saved, /\[REDACTED:private-key\]/);
	for (const output of [saved, content[0].text]) {
		assert.ok(!output.includes(value));
		assert.ok(!output.includes("fixture-material"));
	}
	assert.match(content[0].text, /\[REDACTED:env-value\]/);
	assert.match(content[0].text, /3 value\(s\) redacted/);
	assert.ok(event.content[0].text.includes(value), "does not mutate the caller's parts");
});

test("an incomplete PEM is masked before any offload/truncation", () => {
	const full = lines(1000) + "\n-----BEGIN RSA " + PK + "-----\nfixture-material";
	const content = capResult({ toolName: "read", toolCallId: "fragment", input: {}, content: text(full) }, 12000, [dir])!;
	for (const output of [readFileSync(join(dir, "fragment.txt"), "utf8"), content[0].text]) {
		assert.match(output, /\[REDACTED:private-key\]/);
		assert.ok(!output.includes("fixture-material"));
	}
});

test("unscanned oversized output never reaches disk or the truncated transcript", () => {
	const full = "x".repeat(2 * 1024 * 1024 + 1) + "Pr0dMongo!pass";
	const content = capResult({ toolName: "read", toolCallId: "oversize", input: {}, content: text(full) }, 12000, [dir])!;
	for (const output of [readFileSync(join(dir, "oversize.txt"), "utf8"), content[0].text]) {
		assert.match(output, /Output omitted/);
		assert.ok(!output.includes("Pr0dMongo!pass"));
	}
});

test("offload falls back to the next directory and reports when nothing is writable", () => {
	const ro = join(dir, "ro");
	mkdirSync(ro);
	chmodSync(ro, 0o500);
	const content = capResult({ toolName: "bash", toolCallId: "c1", input: { command: "ls" }, content: text(lines(1000)) }, 5000, [join(ro, "x"), join(dir, "home")]);
	assert.ok(content![0].text.includes(join(dir, "home", "c1.txt")));
	const none = capResult({ toolName: "bash", toolCallId: "c2", input: { command: "ls" }, content: text(lines(1000)) }, 5000, [join(ro, "y")]);
	assert.match(none![0].text, /full output could not be saved/);
	chmodSync(ro, 0o700);
});

test("offloadDirs uses the repo root when there is one, otherwise only home", () => {
	const repo = join(dir, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "src", "deep"), { recursive: true });
	assert.deepEqual(offloadDirs(join(repo, "src", "deep"), "sess/1", "/home/u"), [join(repo, ".ai-work", "tool-out", "sess_1"), "/home/u/.ai-work/tool-out/sess_1"]);
	assert.deepEqual(offloadDirs(join(dir, "plain"), "s", "/home/u"), ["/home/u/.ai-work/tool-out/s"]);
});

test("countLines", () => {
	assert.equal(countLines(""), 0);
	assert.equal(countLines("a"), 1);
	assert.equal(countLines("a\nb\n"), 2);
	assert.equal(countLines("a\nb"), 2);
});

test("config parsing, scopes and off switch", () => {
	assert.deepEqual(parseConfig(null), DISABLED);
	const c = parseConfig({ outputCap: { enabled: true, maxChars: 8000, scope: "main" }, observationMask: { enabled: true, keep: 10, batchTokens: 20000, scope: "bogus" } });
	assert.deepEqual(c.outputCap, { enabled: true, maxChars: 8000, scope: "main" });
	assert.equal(c.observationMask.scope, "subagents");
	assert.equal(c.observationMask.keep, 10);
	assert.equal(parseConfig({ outputCap: { enabled: true } }).observationMask.enabled, false);
	for (const [s, main, sub, unknown] of [["all", true, true, true], ["subagents", false, true, false], ["main", true, false, false], ["off", false, false, false]] as const) {
		assert.equal(scopeAllows(s, "main"), main, s);
		assert.equal(scopeAllows(s, "subagent"), sub, s);
		assert.equal(scopeAllows(s, "unknown"), unknown, s);
	}
});

test("loadConfig re-reads on mtime change and treats missing/invalid files as off", () => {
	const f = join(dir, "efficiency.json");
	assert.equal(loadConfig(f).outputCap.enabled, false);
	writeFileSync(f, JSON.stringify({ outputCap: { enabled: true } }));
	assert.equal(loadConfig(f).outputCap.enabled, true);
	writeFileSync(f, JSON.stringify({ outputCap: { enabled: false } }));
	utimesSync(f, new Date(), new Date(Date.now() + 5000));
	assert.equal(loadConfig(f).outputCap.enabled, false);
	writeFileSync(f, "{not json");
	utimesSync(f, new Date(), new Date(Date.now() + 10000));
	assert.equal(loadConfig(f).outputCap.enabled, false);
});

test("session roles: first session is main, runtime switches move main, others are subagents", () => {
	const r = new SessionRoles();
	assert.equal(r.role("a"), "unknown");
	assert.equal(r.start("a", "startup"), "main");
	assert.equal(r.start("child", "startup"), "subagent");
	assert.equal(r.start("a", "reload"), "main");
	assert.equal(r.start("b", "new"), "main");
	assert.equal(r.role("a"), "subagent");
	assert.equal(r.role("child"), "subagent");
});

test("extension: gated by config and scope, rewrites only large results", async () => {
	const f = join(dir, "eff.json");
	const prev = process.env.PI_EFFICIENCY_FILE;
	process.env.PI_EFFICIENCY_FILE = f;
	const roleKey = Symbol.for("pi-efficiency.session-roles");
	const prevRoles = (globalThis as any)[roleKey];
	delete (globalThis as any)[roleKey];
	try {
		const handlers: Record<string, Function> = {};
		extension({ on: (n: string, h: Function) => { handlers[n] = h; } } as any);
		const ctx = (id: string) => ({ cwd: join(dir, "nogit"), sessionManager: { getSessionId: () => id } });
		handlers.session_start({ reason: "startup" }, ctx("main"));
		handlers.session_start({ reason: "startup" }, ctx("sub"));
		const ev = { toolName: "bash", toolCallId: "t1", input: { command: "ls" }, content: text(lines(1000)), isError: false };
		assert.equal(handlers.tool_result(ev, ctx("main")), undefined, "no config file = off");
		writeFileSync(f, JSON.stringify({ outputCap: { enabled: true, maxChars: 4000, scope: "subagents" } }));
		assert.equal(handlers.tool_result(ev, ctx("main")), undefined, "scope subagents skips main");
		const home = process.env.HOME;
		process.env.HOME = dir;
		try {
			const r = handlers.tool_result(ev, ctx("sub"));
			assert.ok(r?.content?.[0]?.text.includes("[full output:"));
		} finally { process.env.HOME = home; }
		assert.equal(handlers.tool_result({ ...ev, content: text("small") }, ctx("sub")), undefined);
	} finally {
		if (prev === undefined) delete process.env.PI_EFFICIENCY_FILE; else process.env.PI_EFFICIENCY_FILE = prev;
		(globalThis as any)[roleKey] = prevRoles;
	}
});

const DAY = 24 * 3600 * 1000;
const aged = (p: string, days: number) => { writeFileSync(p, "x"); const t = new Date(Date.now() - days * DAY); utimesSync(p, t, t); };

test("logError appends a JSON line and never throws", () => {
	const f = join(dir, "logs", "e.jsonl");
	logError("output-cap", "tool_result", new Error("boom"), f);
	logError("output-cap", "tool_result", "str", f);
	const rows = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(rows.length, 2);
	assert.deepEqual(Object.keys(rows[0]), ["ts", "ext", "event", "message"]);
	assert.equal(rows[0].message, "boom");
	writeFileSync(join(dir, "file"), "");
	assert.doesNotThrow(() => logError("a", "b", "c", join(dir, "file", "sub", "x.jsonl")));
});

test("extension logs a thrown error and fails open", () => {
	const f = join(dir, "err.jsonl");
	const prev = process.env.PI_EFFICIENCY_ERRORS_FILE;
	process.env.PI_EFFICIENCY_ERRORS_FILE = f;
	try {
		const handlers: Record<string, Function> = {};
		extension({ on: (n: string, h: Function) => { handlers[n] = h; } } as any);
		const bad = { cwd: dir, sessionManager: { getSessionId: () => { throw new Error("nosession"); } } };
		assert.equal(handlers.tool_result({}, bad), undefined);
		const row = JSON.parse(readFileSync(f, "utf8").trim().split("\n")[0]);
		assert.equal(row.ext, "output-cap");
		assert.equal(row.event, "tool_result");
		assert.equal(row.message, "nosession");
		assert.equal(errorLogPath(), f);
	} finally {
		if (prev === undefined) delete process.env.PI_EFFICIENCY_ERRORS_FILE; else process.env.PI_EFFICIENCY_ERRORS_FILE = prev;
	}
});

test("pruneToolOut removes only old regular files and emptied session dirs", () => {
	const to = join(dir, ".ai-work", "tool-out");
	mkdirSync(join(to, "s1"), { recursive: true });
	mkdirSync(join(to, "s2"), { recursive: true });
	aged(join(to, "s1", "old.txt"), 5);
	aged(join(to, "s2", "old.txt"), 4);
	aged(join(to, "s2", "new.txt"), 1);
	const outside = join(dir, "outside.txt");
	aged(outside, 9);
	symlinkSync(outside, join(to, "s2", "link.txt"));
	assert.equal(pruneToolOut(to), 2);
	assert.equal(existsSync(join(to, "s1")), false, "emptied session dir removed");
	assert.equal(existsSync(join(to, "s2", "new.txt")), true);
	assert.equal(existsSync(join(to, "s2", "old.txt")), false);
	assert.equal(existsSync(outside), true, "symlink target untouched");
});

test("pruneToolOut refuses directories that are not .ai-work/tool-out and symlinked roots", () => {
	for (const bad of [join(dir, "tool-out"), join(dir, ".ai-work", "other"), join(dir, "x", ".ai-work", "tool-out2")]) {
		mkdirSync(join(bad, "s"), { recursive: true });
		aged(join(bad, "s", "old.txt"), 9);
		assert.equal(pruneToolOut(bad), 0);
		assert.equal(existsSync(join(bad, "s", "old.txt")), true);
	}
	const real = join(dir, "real");
	mkdirSync(join(real, "s"), { recursive: true });
	aged(join(real, "s", "old.txt"), 9);
	mkdirSync(join(dir, "l", ".ai-work"), { recursive: true });
	symlinkSync(real, join(dir, "l", ".ai-work", "tool-out"));
	assert.equal(pruneToolOut(join(dir, "l", ".ai-work", "tool-out")), 0);
	assert.equal(existsSync(join(real, "s", "old.txt")), true);
});

test("pruneOncePerHour runs at most once per hour and covers home and repo root", () => {
	const home = join(dir, "home");
	const repo = join(dir, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	const mk = (base: string, n: string) => { mkdirSync(join(base, ".ai-work", "tool-out", "s"), { recursive: true }); aged(join(base, ".ai-work", "tool-out", "s", n), 5); };
	mk(home, "a.txt"); mk(repo, "b.txt");
	resetPruneGuard();
	const t = Date.now();
	assert.equal(pruneOncePerHour("t", repo, t, home), true);
	assert.equal(existsSync(join(home, ".ai-work", "tool-out", "s")), false);
	assert.equal(existsSync(join(repo, ".ai-work", "tool-out", "s")), false);
	mk(home, "c.txt");
	assert.equal(pruneOncePerHour("t", repo, t + 1000, home), false);
	assert.equal(existsSync(join(home, ".ai-work", "tool-out", "s", "c.txt")), true);
	assert.equal(pruneOncePerHour("t", repo, t + 3600 * 1000 + 1, home), true);
	assert.equal(existsSync(join(home, ".ai-work", "tool-out", "s", "c.txt")), false);
	resetPruneGuard();
});
