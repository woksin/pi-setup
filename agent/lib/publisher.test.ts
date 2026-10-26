import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { publish } from "./publisher.ts";
import type { CaptureHandle, PublisherAdapters, PublisherChild, PublishResult } from "./publisher.ts";
import { MAX_STRING_BYTES } from "./publish-request.ts";

class Child extends EventEmitter implements PublisherChild {
	stdout = new PassThrough(); stderr = new PassThrough(); kills = 0;
	kill() { this.kills++; return true; }
	finish(code: number | null = 0) { this.stdout.end(); this.stderr.end(); this.emit("close", code); }
}
const base = { kind: "issue-comment", repo: "owner/repo", number: 39 };
const safeContext = { home: "/home/scanner-fixture" };
function adapters(spawn?: PublisherAdapters["spawn"]): PublisherAdapters {
	return {
		io: { realpath: async () => "/trusted/gh", stat: async () => ({ size: 1, isFile: () => true }), access: async () => {} },
		spawn: spawn ?? (() => { const child = new Child(); queueMicrotask(() => child.finish()); return child; }),
	};
}
async function fixture(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "publisher-spec-"));
	try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function code(result: PublishResult, expected: string) {
	assert.equal(result.code, expected);
	assert.equal(result.text, expected === "published" ? "published" : expected === "scan-clean" ? "scan clean" : `publish: ${expected}`);
	assert.equal(result.isError, !["published", "scan-clean"].includes(expected));
	assert.doesNotMatch(JSON.stringify(result), /private-value|source\.md|trusted\/gh|stderr/);
}

test("real descriptor capture, permissions, exact BOM/newlines, forced host and sanitized success", () => fixture(async root => {
	const source = join(root, "source.md"), bytes = Buffer.from("\ufeffRelease notes\r\nNo final newline");
	writeFileSync(source, bytes);
	let sent: Buffer | undefined, fileMode = 0, directoryMode = 0, rootMode = 0, snapshot = "";
	let invocation: unknown;
	const mocks = adapters((executable, argv, options) => {
		snapshot = argv.find(arg => arg.startsWith("--body-file="))!.slice("--body-file=".length);
		sent = readFileSync(snapshot); fileMode = statSync(snapshot).mode & 0o777;
		directoryMode = statSync(dirname(snapshot)).mode & 0o777; rootMode = statSync(dirname(dirname(snapshot))).mode & 0o777;
		invocation = { executable, argv, options };
		const child = new Child(); queueMicrotask(() => { child.stdout.write("untrusted private-value\nhttps://github.com/o/r/issues/1\n"); child.stderr.write("stderr private-value"); child.finish(); }); return child;
	});
	mocks.env = { GH_HOST: "evil.invalid", GH_DEBUG: "api", DEBUG: "*", GH_TOKEN: "trusted-auth", KEEP: "yes" };
	code(await publish({ ...base, bodyFile: source }, safeContext, mocks), "published");
	assert.deepEqual(sent, bytes);
	assert.equal(fileMode, 0o600); assert.equal(directoryMode, 0o700); assert.equal(rootMode, 0o700);
	assert.equal(existsSync(snapshot), false);
	const call = invocation as { executable: string; argv: string[]; options: { shell: boolean; stdio: string[]; env: Record<string, string> } };
	assert.equal(call.executable, "/trusted/gh"); assert.equal(call.options.shell, false);
	assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
	assert.equal(call.options.env.GH_HOST, "github.com"); assert.equal(call.options.env.GH_PROMPT_DISABLED, "1");
	assert.equal(call.options.env.GH_NO_UPDATE_NOTIFIER, "1"); assert.equal(call.options.env.GH_PAGER, "cat");
	assert.equal(call.options.env.GH_TOKEN, "trusted-auth"); assert.equal(call.options.env.KEEP, "yes");
	assert.equal(call.options.env.GH_DEBUG, undefined); assert.equal(call.options.env.DEBUG, undefined);
	assert.ok(!call.argv.includes(source));
}));

test("source replacement cannot replace captured/scanned bytes; repeated references open once", () => fixture(async root => {
	const source = join(root, "source.md"); writeFileSync(source, "Original safe body");
	let opens = 0, swapped = false; const sent: string[] = [];
	const mocks = adapters((_executable, argv) => {
		for (const arg of argv.filter(arg => arg.startsWith("--field="))) sent.push(readFileSync(arg.slice(arg.indexOf("=@") + 2), "utf8"));
		const child = new Child(); queueMicrotask(() => child.finish()); return child;
	});
	mocks.io!.open = async (path, flags) => {
		opens++; assert.ok(flags & constants.O_NONBLOCK); assert.ok(flags & constants.O_NOFOLLOW);
		const handle = await fs.open(path, flags);
		return { stat: () => handle.stat(), close: () => handle.close(), read: async (...args) => {
			const read = await handle.read(...args);
			if (!swapped) { swapped = true; await fs.rename(source, source + ".old"); await fs.writeFile(source, "/Users/alice/private-value"); }
			return read;
		} };
	};
	code(await publish({ kind: "api", endpoint: "repos/o/r/issues", method: "PATCH", fields: [{ name: "one", file: source }, { name: "two", file: source }] }, safeContext, mocks), "published");
	assert.equal(opens, 1); assert.deepEqual(sent, ["Original safe body", "Original safe body"]);
	assert.equal(readFileSync(source, "utf8"), "/Users/alice/private-value");
}));

test("gist snapshots preserve duplicate public basenames in distinct numbered directories", () => fixture(async root => {
	await fs.mkdir(join(root, "one")); await fs.mkdir(join(root, "two"));
	const files = [join(root, "one", "same.md"), join(root, "two", "same.md")];
	writeFileSync(files[0], "First"); writeFileSync(files[1], "Second");
	let paths: string[] = [], sent: string[] = [];
	const mocks = adapters((_executable, argv) => {
		paths = argv.slice(2); sent = paths.map(path => readFileSync(path, "utf8"));
		const child = new Child(); queueMicrotask(() => child.finish()); return child;
	});
	code(await publish({ kind: "gist-create", files }, safeContext, mocks), "published");
	assert.deepEqual(sent, ["First", "Second"]); assert.notEqual(dirname(paths[0]), dirname(paths[1]));
	assert.ok(paths.every(path => path.endsWith("/same.md") && !existsSync(path)));
}));

function fakeHandle(options: { size?: number; regular?: boolean; read?: CaptureHandle["read"]; stat?: CaptureHandle["stat"] } = {}) {
	let closes = 0;
	const handle: CaptureHandle = {
		stat: options.stat ?? (async () => ({ size: options.size ?? 0, isFile: () => options.regular ?? true })),
		read: options.read ?? (async () => ({ bytesRead: 0 })), close: async () => { closes++; },
	};
	return { handle, closes: () => closes };
}

test("growth cannot evade the initial stat: total descriptor reads bounded at MAX+1", async () => {
	let budget = 0;
	const file = fakeHandle({ size: 1, read: async (buffer, _offset, length) => { budget += length; buffer.fill("a"); return { bytesRead: length }; } });
	const mocks = adapters(); mocks.io!.open = async () => file.handle;
	code(await publish({ ...base, bodyFile: "source.md" }, safeContext, mocks), "payload-too-large");
	assert.equal(budget, MAX_STRING_BYTES + 1); assert.equal(file.closes(), 1);
});

test("post-read stat detects late over-limit growth", async () => {
	let stats = 0;
	const file = fakeHandle({ stat: async () => ({ size: ++stats === 1 ? 0 : MAX_STRING_BYTES + 1, isFile: () => true }) });
	const mocks = adapters(); mocks.io!.open = async () => file.handle;
	code(await publish({ ...base, bodyFile: "source.md" }, safeContext, mocks), "payload-too-large");
	assert.equal(file.closes(), 1);
});

for (const pathType of ["directory", "symlink", "fifo", "missing"] as const) test(`real ${pathType} source refuses promptly without child or snapshots`, () => fixture(async root => {
	const source = join(root, "source.md");
	if (pathType === "directory") await fs.mkdir(source);
	if (pathType === "symlink") { writeFileSync(join(root, "target"), "safe"); await fs.symlink(join(root, "target"), source); }
	if (pathType === "fifo") execFileSync("/usr/bin/mkfifo", [source]);
	let spawns = 0, snapshots = 0;
	const mocks = adapters(() => { spawns++; return new Child(); });
	mocks.io!.mkdtemp = async () => { snapshots++; throw new Error("private-value"); };
	code(await publish({ ...base, bodyFile: source }, safeContext, mocks), "payload-unreadable");
	assert.equal(spawns, 0); assert.equal(snapshots, 0);
}));

test("nonregular and initially oversized descriptors close without any read", async () => {
	for (const options of [{ regular: false }, { size: MAX_STRING_BYTES + 1 }]) {
		let reads = 0;
		const file = fakeHandle({ ...options, read: async () => { reads++; return { bytesRead: 0 }; } });
		const mocks = adapters(); mocks.io!.open = async () => file.handle;
		code(await publish({ kind: "check", files: ["source.md"] }, safeContext, mocks), options.regular === false ? "payload-unreadable" : "payload-too-large");
		assert.equal(reads, 0); assert.equal(file.closes(), 1);
	}
});

test("cancellation before and between reads closes the descriptor and never spawns", async () => {
	for (const initially of [false, true]) {
		const controller = new AbortController(); let opens = 0;
		if (initially) controller.abort(new Error("private-value"));
		const file = fakeHandle({ read: async () => { controller.abort("private-value"); return { bytesRead: 0 }; } });
		const mocks = adapters(); mocks.io!.open = async () => { opens++; return file.handle; };
		code(await publish({ ...base, bodyFile: "source.md" }, { ...safeContext, signal: controller.signal }, mocks), "cancelled");
		assert.equal(opens, initially ? 0 : 1); assert.equal(file.closes(), initially ? 0 : 1);
	}
});

test("unsupported capture platform fails closed, without open", async () => {
	const mocks = adapters(); mocks.platform = "win32";
	mocks.io!.open = async () => { assert.fail("must not open"); };
	code(await publish({ kind: "check", files: ["source.md"] }, safeContext, mocks), "unsupported-platform");
	code(await publish({ ...base, body: "Safe inline" }, safeContext, mocks), "unsupported-platform");
});

test("fatal UTF-8 decoding, scan refusal and aggregate budget all precede snapshots/spawn", () => fixture(async root => {
	const invalid = join(root, "invalid"), sensitive = join(root, "sensitive");
	writeFileSync(invalid, Buffer.from([0xff])); writeFileSync(sensitive, "/Users/alice/private-value");
	let calls = 0;
	const mocks = adapters(() => { calls++; return new Child(); }); mocks.io!.mkdtemp = async () => { calls++; throw new Error("private-value"); };
	code(await publish({ ...base, bodyFile: invalid }, safeContext, mocks), "payload-not-utf8");
	const refused = await publish({ ...base, bodyFile: sensitive }, safeContext, mocks);
	code(refused, "scan-refused"); assert.equal(refused.diagnostics?.source, "body");
	assert.deepEqual(refused.diagnostics?.findings, [{ kind: "home-path", line: 1 }]);
	const large = join(root, "large"); writeFileSync(large, "a".repeat(MAX_STRING_BYTES));
	code(await publish({ kind: "check", files: Array(5).fill(large) }, safeContext, mocks), "payload-too-large");
	assert.equal(calls, 0);
}));

test("all outbound scalars and source basenames scan; original private file paths do not", () => fixture(async root => {
	const file = join(root, "source.md"); writeFileSync(file, "Safe");
	code(await publish({ ...base, bodyFile: file }, safeContext, adapters()), "published");
	for (const request of [
		{ kind: "issue-create", repo: "owner/repo", title: "/Users/alice/private-value", body: "Safe" },
		{ kind: "api", endpoint: "repos/o/r?q=/Users/alice/private-value", method: "POST" },
		{ kind: "api", endpoint: "repos/o/r", method: "POST", fields: [{ name: "x", value: "/Users/alice/private-value" }] },
		{ kind: "gist-create", files: [join(root, "[REDACTED:marker]")] },
	]) code(await publish(request, safeContext, adapters()), "scan-refused");
}));

test("check only captures and scans; creates no snapshot and never resolves/spawns gh", () => fixture(async root => {
	const source = join(root, "source.md"); writeFileSync(source, "Safe");
	const mocks = adapters(() => { assert.fail("must not spawn"); });
	mocks.io!.mkdtemp = async () => { assert.fail("must not snapshot"); };
	mocks.io!.realpath = async () => { assert.fail("must not resolve gh"); };
	code(await publish({ kind: "check", files: [source] }, safeContext, mocks), "scan-clean");
}));

test("reopen comment uses captured content, never source name; BOM and whitespace survive", () => fixture(async root => {
	const source = join(root, "source.md"); writeFileSync(source, "\ufeff--not-a-flag\r\n");
	let argv: string[] = [];
	const mocks = adapters((_path, args) => { argv = args; const child = new Child(); queueMicrotask(() => child.finish()); return child; });
	code(await publish({ ...base, kind: "issue-reopen", bodyFile: source }, safeContext, mocks), "published");
	assert.ok(argv.includes("--comment=\ufeff--not-a-flag\r\n")); assert.ok(!argv.some(arg => arg.includes("source.md")));
}));

for (const stream of ["stdout", "stderr"] as const) test(`bounded ${stream} output kills mock child, awaits close before cleanup`, () => fixture(async root => {
	let child!: Child, snapshot = "", start!: () => void;
	const started = new Promise<void>(resolve => { start = resolve; });
	const mocks = adapters((_path, argv) => { snapshot = argv.find(arg => arg.startsWith("--body-file="))!.slice(12); child = new Child(); start(); return child; });
	mocks.temporaryRoot = () => root;
	const pending = publish({ ...base, body: "Safe" }, safeContext, mocks);
	await started; child[stream].write(Buffer.alloc(256 * 1024 + 1));
	assert.equal(child.kills, 1); assert.equal(existsSync(snapshot), true);
	child.finish(null); code(await pending, "gh-output-limit"); assert.equal(existsSync(snapshot), false);
}));

for (const termination of ["abort", "timeout", "error", "nonzero"] as const) test(`${termination} has fixed output and cleanup follows child close`, () => fixture(async root => {
	const controller = new AbortController(); let child!: Child, snapshot = "", fire!: () => void, start!: () => void, timersCleared = 0;
	const started = new Promise<void>(resolve => { start = resolve; });
	const mocks = adapters((_path, argv) => { snapshot = argv.find(arg => arg.startsWith("--body-file="))!.slice(12); child = new Child(); start(); return child; });
	mocks.temporaryRoot = () => root; mocks.clock = { after: (ms, callback) => { assert.equal(ms, 120000); fire = callback; return () => { timersCleared++; }; } };
	const pending = publish({ ...base, body: "Safe" }, { ...safeContext, signal: controller.signal }, mocks);
	await started;
	if (termination === "abort") controller.abort(new Error("private-value"));
	if (termination === "timeout") fire();
	if (termination === "error") { child.emit("error", new Error("stderr private-value")); child.emit("error", new Error("second private-value")); }
	assert.equal(existsSync(snapshot), true); assert.equal(child.kills, termination === "nonzero" ? 0 : 1);
	child.finish(2);
	code(await pending, ({ abort: "cancelled", timeout: "gh-timeout", error: "gh-failed", nonzero: "gh-failed" })[termination]);
	assert.equal(existsSync(snapshot), false); assert.equal(timersCleared, 1);
}));

test("spawn throw, gh lookup failure and cleanup failure cannot echo error values", () => fixture(async root => {
	const mocks = adapters(() => { throw new Error("stderr private-value source.md"); }); mocks.temporaryRoot = () => root;
	code(await publish({ ...base, body: "Safe" }, safeContext, mocks), "gh-failed");
	const candidates: string[] = []; mocks.io!.realpath = async path => { candidates.push(path); throw new Error("private-value"); };
	code(await publish({ ...base, body: "Safe" }, safeContext, mocks), "gh-unavailable");
	assert.deepEqual(candidates, ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "/bin/gh"]);
	mocks.io!.rm = async () => { throw new Error("private-value"); };
	code(await publish({ ...base, body: "Safe" }, safeContext, mocks), "cleanup-failed");
}));

test("all sources must pass before any private snapshot or child exists", () => fixture(async root => {
	const safe = join(root, "safe"), unsafe = join(root, "unsafe");
	writeFileSync(safe, "Safe"); writeFileSync(unsafe, "/Users/alice/private-value");
	let snapshots = 0, spawns = 0;
	const mocks = adapters(() => { spawns++; return new Child(); }); mocks.io!.mkdtemp = async () => { snapshots++; throw new Error("private-value"); };
	const refused = await publish({ kind: "api", endpoint: "repos/o/r", method: "POST", fields: [{ name: "one", file: safe }, { name: "two", file: unsafe }] }, safeContext, mocks);
	code(refused, "scan-refused"); assert.equal(refused.diagnostics?.source, "fields[1]");
	assert.equal(snapshots, 0); assert.equal(spawns, 0);
}));

test("read and close errors are value-free and still attempt close", async () => {
	for (const broken of ["read", "close"] as const) {
		let closes = 0;
		const file = fakeHandle();
		file.handle[broken] = async () => { if (broken === "close") closes++; throw new Error("private-value source.md"); };
		if (broken === "read") file.handle.close = async () => { closes++; };
		const mocks = adapters(); mocks.io!.open = async () => file.handle;
		code(await publish({ kind: "check", files: ["source.md"] }, safeContext, mocks), "payload-unreadable");
		assert.equal(closes, 1);
	}
});

test("cancellation while open is pending closes its eventual descriptor", async () => {
	const controller = new AbortController(), file = fakeHandle(); let resolveOpen!: (handle: CaptureHandle) => void, entered!: () => void;
	const opened = new Promise<void>(resolve => { entered = resolve; });
	const mocks = adapters(); mocks.io!.open = async () => { entered(); return new Promise(resolve => { resolveOpen = resolve; }); };
	const pending = publish({ ...base, bodyFile: "source.md" }, { ...safeContext, signal: controller.signal }, mocks);
	await opened; controller.abort("private-value"); resolveOpen(file.handle);
	code(await pending, "cancelled"); assert.equal(file.closes(), 1);
});

for (const interrupted of ["chmod", "write", "cancel"] as const) test(`snapshot ${interrupted} interruption cleans the complete private root without spawning`, () => fixture(async root => {
	const controller = new AbortController(); let temporary = "", spawns = 0;
	const mocks = adapters(() => { spawns++; return new Child(); });
	mocks.temporaryRoot = () => root;
	mocks.io!.mkdtemp = async prefix => { temporary = await fs.mkdtemp(prefix); return temporary; };
	if (interrupted === "chmod") mocks.io!.chmod = async () => { throw new Error("private-value"); };
	mocks.io!.writeFile = async (path, bytes, options) => {
		if (interrupted === "write") throw new Error("private-value");
		await fs.writeFile(path, bytes, options);
		if (interrupted === "cancel") controller.abort("private-value");
	};
	code(await publish({ ...base, body: "Safe" }, { ...safeContext, signal: controller.signal }, mocks), interrupted === "cancel" ? "cancelled" : "payload-unreadable");
	assert.ok(temporary); assert.equal(existsSync(temporary), false); assert.equal(spawns, 0);
}));

test("executable resolution refuses relative, nonregular and nonexecutable candidates and ignores PATH", async () => {
	let executable = ""; const looked: string[] = [];
	const mocks = adapters((path) => { executable = path; const child = new Child(); queueMicrotask(() => child.finish()); return child; });
	mocks.env = { PATH: "/untrusted/private-value" };
	mocks.io!.realpath = async path => { looked.push(path); return path === "/opt/homebrew/bin/gh" ? "relative/gh" : path; };
	mocks.io!.stat = async path => ({ size: 1, isFile: () => path !== "/usr/local/bin/gh" });
	mocks.io!.access = async path => { if (path === "/usr/bin/gh") throw new Error("private-value"); };
	code(await publish({ ...base, body: "Safe" }, safeContext, mocks), "published");
	assert.equal(executable, "/bin/gh"); assert.equal(looked.length, 4);
});

test("output exactly at each stream limit is discarded without rejecting success", async () => {
	const mocks = adapters(() => { const child = new Child(); queueMicrotask(() => { child.stdout.write(Buffer.alloc(256 * 1024)); child.stderr.write(Buffer.alloc(256 * 1024)); child.finish(); }); return child; });
	code(await publish({ ...base, body: "Safe" }, safeContext, mocks), "published");
});

test("unsupported operations fail validation before any IO", async () => {
	let calls = 0; const mocks = adapters(); mocks.io!.open = async () => { calls++; throw new Error("private-value"); };
	code(await publish({ ...base, kind: "issue-delete", bodyFile: "source.md" }, safeContext, mocks), "invalid-request");
	assert.equal(calls, 0);
});
