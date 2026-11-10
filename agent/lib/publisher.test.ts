import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
	assert.doesNotMatch(JSON.stringify(result), /private-value|trusted\/gh|stderr/);
	if (!["invalid-request", "gh-failed", "payload-not-found", "payload-symlink", "payload-not-file", "payload-permission", "payload-too-large", "payload-unreadable"].includes(expected)) assert.equal(result.detail, undefined);
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
	code(await publish({ ...base, bodyFile: source }, safeContext, mocks), ({ directory: "payload-not-file", symlink: "payload-symlink", fifo: "payload-not-file", missing: "payload-not-found" })[pathType]);
	assert.equal(spawns, 0); assert.equal(snapshots, 0);
}));

test("nonregular and initially oversized descriptors close without any read", async () => {
	for (const options of [{ regular: false }, { size: MAX_STRING_BYTES + 1 }]) {
		let reads = 0;
		const file = fakeHandle({ ...options, read: async () => { reads++; return { bytesRead: 0 }; } });
		const mocks = adapters(); mocks.io!.open = async () => file.handle;
		code(await publish({ kind: "check", files: ["source.md"] }, safeContext, mocks), options.regular === false ? "payload-not-file" : "payload-too-large");
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

for (const [errno, expected] of [
	["ENOENT", "payload-not-found"], ["ENOTDIR", "payload-not-found"], ["ELOOP", "payload-symlink"],
	["EISDIR", "payload-not-file"], ["EACCES", "payload-permission"], ["EPERM", "payload-permission"],
	["EIO", "payload-unreadable"], ["toString", "payload-unreadable"], [undefined, "payload-unreadable"],
] as const) test(`open errno ${errno} uses only whitelisted code and caller path`, async () => {
	const mocks = adapters(); let opened = "";
	mocks.io!.open = async path => { opened = path; throw Object.assign(new Error("private-value"), { code: errno, path: "private-value" }); };
	const result = await publish({ ...base, bodyFile: "draft.md" }, { ...safeContext, cwd: "/workspace/project" }, mocks);
	code(result, expected); assert.equal(opened, "/workspace/project/draft.md");
	assert.equal(result.detail, expected === "payload-unreadable" ? (errno === "EIO" ? "code=EIO" : undefined) : "/workspace/project/draft.md");
});

test("capture details abbreviate only the home component, sanitize and bound caller paths", async () => {
	const mocks = adapters(); mocks.io!.open = async () => { throw Object.assign(new Error("private-value"), { code: "ENOENT" }); };
	for (const [cwd, expected] of [["/home/person/project", "~/project/draft.md"], ["/home/person-other", "/home/person-other/draft.md"], ["/work/\u200b\n", "/work/??/draft.md"]]) {
		const result = await publish({ ...base, bodyFile: "draft.md" }, { home: "/home/person", cwd }, mocks);
		assert.equal(result.detail, expected);
	}
	const result = await publish({ ...base, bodyFile: "a".repeat(400) }, { ...safeContext, cwd: "/workspace" }, mocks);
	assert.equal(result.detail?.length, 300);
});

for (const errno of ["EIO", "EACCES", "EIO private-value", "EIO\n", "EE", "E" + "A".repeat(20), "private-value", undefined]) test(`unreadable capture keeps only a bare errno token: ${JSON.stringify(errno)}`, async () => {
	const file = fakeHandle();
	file.handle.read = async () => { throw Object.assign(new Error("private-value file contents"), { code: errno, path: "/private-value/source.md" }); };
	const mocks = adapters(); mocks.io!.open = async () => file.handle;
	const result = await publish({ ...base, bodyFile: "source.md" }, safeContext, mocks);
	code(result, "payload-unreadable");
	assert.equal(result.detail, errno === "EIO" || errno === "EACCES" ? `code=${errno}` : undefined);
	assert.ok(!JSON.stringify(result).includes("source.md")); assert.ok(!JSON.stringify(result).includes("file contents"));
});

test("oversize descriptors name the resolved caller path; read and close errors expose only errno", async () => {
	const mocks = adapters(); mocks.io!.open = async () => fakeHandle({ size: MAX_STRING_BYTES + 1 }).handle;
	const result = await publish({ ...base, bodyFile: "draft.md" }, safeContext, mocks);
	assert.equal(result.detail, resolve("draft.md"));
	for (const operation of ["read", "close"] as const) {
		const file = fakeHandle(); file.handle[operation] = async () => { throw Object.assign(new Error("private-value"), { code: "ENOENT" }); };
		mocks.io!.open = async () => file.handle;
		const failed = await publish({ ...base, bodyFile: "draft.md" }, safeContext, mocks);
		code(failed, "payload-unreadable"); assert.equal(failed.detail, "code=ENOENT");
	}
});

for (const [message, category, advice] of [
	["gh: API rate limit exceeded (HTTP 403)", "rate-limit", "retry once, then stop"],
	["HTTP 403 secondary rate limit", "rate-limit", "retry once, then stop"],
	["HTTP 429", "rate-limit", "retry once, then stop"],
	["HTTP 403 Forbidden", "auth", "do not retry; check gh auth status"],
	["gh: Not Found (HTTP 404)", "not-found", "do not retry; fix the request (repo, number, fields)"],
	["HTTP 401: Bad credentials", "auth", "do not retry; check gh auth status"],
	["HTTP 422: Validation Failed", "validation", "do not retry; fix the request (repo, number, fields)"],
	["error connecting: connection reset to api.github.com", "network", "retry once, then stop"],
	["HTTP 503 Service Unavailable", "network", "retry once, then stop"],
	["error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com", "network", "retry once, then stop"],
	["dial tcp: no such host", "network", "retry once, then stop"],
	["TLS handshake timed out", "network", "retry once, then stop"],
	["unexpected failure", "unclassified", "do not retry blindly"],
] as const) test(`gh stderr classifies ${category} without retaining any received text`, async () => {
	const mocks = adapters(() => {
		const child = new Child(); queueMicrotask(() => {
			child.stdout.write("HTTP 401: Bad credentials");
			child.stderr.emit("data", Buffer.from(message.slice(0, 8)));
			child.stderr.emit("data", message.slice(8) + " private-value PAYLOAD-SENTINEL"); child.finish(1);
		}); return child;
	});
	const result = await publish({ ...base, body: "PAYLOAD-SENTINEL" }, safeContext, mocks);
	const status = message.match(/HTTP (\d{3})/)?.[1];
	code(result, "gh-failed"); assert.equal(result.detail, `exit=1 category=${category}${status ? `; status=${status}` : ""}; ${advice}`);
	assert.ok(!JSON.stringify(result).includes("PAYLOAD-SENTINEL"));
});

for (const termination of ["signal", "spawn", "child-error", "stream-error"] as const) test(`gh ${termination} has a value-free unclassified detail`, async () => {
	const mocks = adapters(() => {
		if (termination === "spawn") throw new Error("private-value");
		const child = new Child(); queueMicrotask(() => {
			child.stderr.write("HTTP 403 API rate limit exceeded private-value");
			if (termination === "child-error") child.emit("error", new Error("private-value"));
			if (termination === "stream-error") child.stderr.emit("error", new Error("private-value"));
			child.finish(null);
		}); return child;
	});
	const result = await publish({ ...base, body: "Safe" }, safeContext, mocks);
	code(result, "gh-failed");
	assert.equal(result.detail, termination === "signal" ? "exit=none category=rate-limit; retry once, then stop" : "exit=none category=unclassified; do not retry blindly");
});

test("streaming UTF-8 stderr decoding handles split characters and a split category", async () => {
	const mocks = adapters(() => {
		const child = new Child(); queueMicrotask(() => {
			const bytes = Buffer.from("gh: é Validation Failed (HTTP 422)\n\nprivate-value");
			for (const byte of bytes) child.stderr.emit("data", Buffer.from([byte]));
			child.finish(3);
		}); return child;
	});
	const result = await publish({ ...base, body: "Safe" }, safeContext, mocks);
	code(result, "gh-failed"); assert.equal(result.detail, 'exit=3 category=validation; status=422; message="é Validation Failed"; do not retry; fix the request (repo, number, fields)');
});

async function ghError(stderr: string, request: unknown = { ...base, body: "Safe body" }): Promise<PublishResult> {
	const mocks = adapters(() => {
		const child = new Child(); queueMicrotask(() => {
			child.stdout.write("gh: private-value (HTTP 401)"); child.stderr.write(stderr); child.finish(1);
		}); return child;
	});
	const result = await publish(request, safeContext, mocks);
	code(result, "gh-failed"); return result;
}

test("gh failure surfaces status and bounded API validation lines from stderr only", async () => {
	const result = await ghError("gh: Validation Failed (HTTP 422)\nvulnerabilities.package is invalid\n\nprivate-value");
	assert.equal(result.detail, 'exit=1 category=validation; status=422; message="Validation Failed vulnerabilities.package is invalid"; do not retry; fix the request (repo, number, fields)');
});

for (const unsafe of [["gh", "p_", "a1".repeat(20)].join(""), "/Users/alice/private-value", "https://user:private-value@example.invalid"]) test("gh message drops entire scanner-hit lines, not just the secret", async () => {
	const result = await ghError(`gh: Validation Failed (HTTP 422)\nunsafe-marker ${unsafe}\npackage is invalid`);
	assert.match(result.detail!, /message="Validation Failed package is invalid"/);
	assert.ok(!result.detail!.includes(unsafe)); assert.ok(!result.detail!.includes("unsafe-marker"));
});

test("gh message drops echoed field values and keeps status when no message survives", async () => {
	const result = await ghError("gh: Invalid value 'zzzzzz' (HTTP 422)", { kind: "api", endpoint: "repos/o/r", method: "POST", fields: [{ name: "name", value: "zzzzzz" }] });
	assert.equal(result.detail, "exit=1 category=validation; status=422; do not retry; fix the request (repo, number, fields)");
});

for (const body of ["REQUEST-BODY-SENTINEL", "First line\nREQUEST-BODY-SENTINEL\nLast line", JSON.stringify({ body: "REQUEST-BODY-SENTINEL" }), JSON.stringify({ body: "First line\nREQUEST-BODY-SENTINEL\nLast line" })]) test("gh message drops echoed inline body text", async () => {
	const result = await ghError("gh: Invalid value REQUEST-BODY-SENTINEL (HTTP 422)", { ...base, body });
	assert.doesNotMatch(result.detail!, /REQUEST-BODY-SENTINEL|message=/);
});

test("gh message filters against captured file bytes, including JSON string values", () => fixture(async root => {
	const file = join(root, "body.json"); writeFileSync(file, JSON.stringify({ body: "FILE-BODY-SENTINEL" }));
	const result = await ghError("gh: Invalid value FILE-BODY-SENTINEL (HTTP 422)", { kind: "api", endpoint: "repos/o/r", method: "POST", bodyFile: file });
	assert.doesNotMatch(result.detail!, /FILE-BODY-SENTINEL|message=/);
}));

test("gh message strips controls, normalizes whitespace and JSON-quotes structure", async () => {
	const result = await ghError('gh: Invalid\u0000\u200b   "input"\tvalue (HTTP 422)');
	assert.match(result.detail!, /message="Invalid \\"input\\" value"/);
	assert.doesNotMatch(result.detail!, /[\p{Cc}\p{Cf}]/u);
});

test("gh message filters full lines before truncation, including control-obfuscated reflections", async () => {
	const result = await ghError(`gh: ${"x".repeat(121)} Invalid REQUE\u0000ST-BODY-SENTINEL (HTTP 422)`, { ...base, body: "REQUEST-BODY-SENTINEL" });
	assert.doesNotMatch(result.detail!, /message=/);
});

test("gh message caps each line at 120, total text at 400, and consumes at most three following lines", async () => {
	const result = await ghError(`gh: ${"a".repeat(150)} (HTTP 422)\n${"b".repeat(150)}\n${"c".repeat(150)}\n${"d".repeat(150)}\nprivate-value`);
	const message = JSON.parse(result.detail!.match(/message=(".*"); do not retry/)![1]);
	assert.equal(message, ["a".repeat(120), "b".repeat(120), "c".repeat(120), "d".repeat(120)].join(" ").slice(0, 400));
});

test("successful gh exit never exposes or classifies stderr", async () => {
	const mocks = adapters(() => {
		const child = new Child(); queueMicrotask(() => { child.stderr.write("gh: HTTP 401 private-value"); child.finish(0); }); return child;
	});
	code(await publish({ ...base, body: "Safe" }, safeContext, mocks), "published");
});

test("gh classification retains only the first 16 KiB and ignores stdout", async () => {
	const mocks = adapters(() => {
		const child = new Child(); queueMicrotask(() => {
			child.stdout.write("HTTP 401"); child.stderr.write("x".repeat(16 * 1024)); child.stderr.write("HTTP 401 private-value"); child.finish(7);
		}); return child;
	});
	const result = await publish({ ...base, body: "Safe" }, safeContext, mocks);
	assert.equal(result.detail, "exit=7 category=unclassified; do not retry blindly");
});

test("unsupported operations fail validation before any IO", async () => {
	let calls = 0; const mocks = adapters(); mocks.io!.open = async () => { calls++; throw new Error("private-value"); };
	code(await publish({ ...base, kind: "issue-delete", bodyFile: "source.md" }, safeContext, mocks), "invalid-request");
	assert.equal(calls, 0);
});

const hostedBase = { ...base, host: "ghe.example.com" };
const ambientTokens = { GH_TOKEN: "env-token", GITHUB_TOKEN: "env-token", GH_ENTERPRISE_TOKEN: "env-token", GITHUB_ENTERPRISE_TOKEN: "env-token", GH_REPO: "other/repo", GH_HOST: "evil.invalid", KEEP: "yes" };
const TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
type Spawned = { argv: string[]; env: NodeJS.ProcessEnv };
function recording(exitCodes: Record<string, number | null> = {}) {
	const calls: Spawned[] = [];
	const mocks = adapters((_executable, argv, options) => {
		calls.push({ argv, env: options.env as NodeJS.ProcessEnv });
		const child = new Child(); queueMicrotask(() => child.finish(exitCodes[argv[0]] ?? 0)); return child;
	});
	mocks.env = { ...ambientTokens };
	return { calls, mocks };
}

test("hosted run: preflight then send; send pins GH_HOST to the host over ambient GH_HOST and uses HOST/OWNER/REPO", async () => {
	const { calls, mocks } = recording();
	code(await publish({ ...hostedBase, body: "Safe" }, safeContext, mocks), "published");
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].argv, ["auth", "status", "--hostname=ghe.example.com"]);
	assert.equal(calls[1].env.GH_HOST, "ghe.example.com");
	assert.ok(calls[1].argv.includes("--repo=ghe.example.com/owner/repo")); assert.ok(!calls[1].argv.includes("--repo=owner/repo"));
	const api = recording();
	code(await publish({ kind: "api", endpoint: "repos/o/r/issues", method: "POST", host: "ghe.example.com" }, safeContext, api.mocks), "published");
	assert.ok(api.calls[1].argv.includes("--hostname=ghe.example.com")); assert.ok(!api.calls[1].argv.includes("--hostname=github.com"));
});

test("token isolation: hosted preflight and send carry no env token, GH_REPO or target GH_HOST; github.com keeps only GH_TOKEN/GITHUB_TOKEN", async () => {
	const hosted = recording();
	code(await publish({ ...hostedBase, body: "Safe" }, safeContext, hosted.mocks), "published");
	const [preflight, sent] = hosted.calls;
	for (const env of [preflight.env, sent.env]) {
		for (const name of [...TOKEN_NAMES, "GH_REPO", "GH_DEBUG", "DEBUG"]) assert.equal(env[name], undefined, name);
		assert.equal(env.KEEP, "yes"); assert.equal(env.GH_PROMPT_DISABLED, "1");
	}
	assert.equal("GH_HOST" in preflight.env, false); assert.ok(!Object.values(preflight.env).includes("ghe.example.com"));
	const plain = recording();
	code(await publish({ ...base, body: "Safe" }, safeContext, plain.mocks), "published");
	assert.equal(plain.calls.length, 1);
	const env = plain.calls[0].env;
	assert.equal(env.GH_HOST, "github.com"); assert.equal(env.GH_TOKEN, "env-token"); assert.equal(env.GITHUB_TOKEN, "env-token");
	for (const name of ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_REPO"]) assert.equal(env[name], undefined, name);
});

test("host github.com is the default path: no preflight, same argv and env as no host", async () => {
	const explicit = recording(), implicit = recording();
	code(await publish({ ...base, host: "github.com", body: "Safe" }, safeContext, explicit.mocks), "published");
	code(await publish({ ...base, body: "Safe" }, safeContext, implicit.mocks), "published");
	assert.equal(explicit.calls.length, 1);
	assert.deepEqual(explicit.calls[0].argv.slice(0, 4), implicit.calls[0].argv.slice(0, 4)); assert.deepEqual(explicit.calls[0].env, implicit.calls[0].env);
});

test("failing preflight is host-unauthenticated with no snapshot and no send", async () => {
	const { calls, mocks } = recording({ auth: 1 });
	let snapshots = 0; mocks.io!.mkdtemp = async () => { snapshots++; throw new Error("private-value"); };
	code(await publish({ ...hostedBase, body: "Safe" }, safeContext, mocks), "host-unauthenticated");
	assert.equal(calls.length, 1); assert.equal(calls[0].argv[0], "auth"); assert.equal(snapshots, 0);
	const spawnThrows = adapters(() => { throw new Error("private-value"); });
	code(await publish({ ...hostedBase, body: "Safe" }, safeContext, spawnThrows), "host-unauthenticated");
});

test("host never bypasses scanning: refused body, refused host text and check-with-host spawn nothing", () => fixture(async root => {
	const { calls, mocks } = recording();
	const refused = await publish({ ...hostedBase, body: "/Users/alice/private-value" }, safeContext, mocks);
	code(refused, "scan-refused"); assert.equal(refused.diagnostics?.source, "body");
	const file = join(root, "body.md"); writeFileSync(file, "/Users/alice/private-value");
	code(await publish({ ...hostedBase, bodyFile: file }, safeContext, mocks), "scan-refused");
	code(await publish({ kind: "check", files: [file], host: "ghe.example.com" }, safeContext, mocks), "invalid-request");
	code(await publish({ ...base, host: "GHE.example.com", body: "Safe" }, safeContext, mocks), "invalid-request");
	assert.equal(calls.length, 0);
}));

test("preflight cancellation and timeout keep their existing codes and never send", async () => {
	for (const termination of ["abort", "timeout"] as const) {
		const controller = new AbortController(); let fire!: () => void, child!: Child, start!: () => void; const argvs: string[][] = [];
		const started = new Promise<void>(resolve => { start = resolve; });
		const mocks = adapters((_path, argv) => { argvs.push(argv); child = new Child(); start(); return child; });
		mocks.clock = { after: (_ms, callback) => { fire = callback; return () => {}; } };
		const pending = publish({ ...hostedBase, body: "Safe" }, { ...safeContext, signal: controller.signal }, mocks);
		await started;
		if (termination === "abort") controller.abort("private-value"); else fire();
		assert.equal(child.kills, 1); child.finish(null);
		code(await pending, termination === "abort" ? "cancelled" : "gh-timeout");
		assert.equal(argvs.length, 1); assert.equal(argvs[0][0], "auth");
	}
});

test("plain UTF-8 bodyFile by absolute and cwd-relative path publishes from a real tmpdir (symlinked /var on macOS)", () => fixture(async root => {
	const source = join(root, "comment.md"); writeFileSync(source, "Plain UTF-8 body — æøå\n");
	for (const [bodyFile, cwd] of [[source, undefined], ["comment.md", root]] as const) {
		let sent = "";
		const mocks = adapters((_executable, argv) => {
			sent = readFileSync(argv.find(arg => arg.startsWith("--body-file="))!.slice("--body-file=".length), "utf8");
			const child = new Child(); queueMicrotask(() => child.finish()); return child;
		});
		code(await publish({ ...base, bodyFile }, { ...safeContext, cwd }, mocks), "published");
		assert.equal(sent, "Plain UTF-8 body — æøå\n");
	}
}));
