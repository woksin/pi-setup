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
function code(result: PublishResult, expected: string, detail?: string) {
	assert.equal(result.code, expected);
	assert.equal(result.text, expected === "published" ? "published" : expected === "scan-clean" ? "scan clean" : `publish: ${expected}`);
	assert.equal(result.isError, !["published", "scan-clean"].includes(expected));
	assert.doesNotMatch(JSON.stringify(result), /private-value|trusted\/gh|stderr/);
	if (detail !== undefined || !["invalid-request", "gh-failed", "payload-not-found", "payload-symlink", "payload-not-file", "payload-permission", "payload-too-large"].includes(expected)) assert.equal(result.detail, detail);
}

test("API file payloads cannot edit issue text or existing comments, including GraphQL", () => fixture(async root => {
	const source = join(root, "input.json");
	let spawned = 0;
	const mocks = adapters(() => { spawned++; throw new Error("must not reach gh"); });
	for (const [endpoint, text, field] of [
		["repos/o/r/issues/3", '{"body":"Replacement"}', undefined],
		["repos/o/r/issues/3", '{"title":"Replacement"}', undefined],
		["repos/o/r/issues/3", '[]', undefined],
		["graphql", '{"query":"mutation { updateIssue(input: $input) { clientMutationId } }"}', undefined],
		["graphql", '{"query":"mutation { \\u0075pdateIssue(input: $input) { clientMutationId } }"}', undefined],
		["graphql", "mutation { updateIssueComment(input: $input) { clientMutationId } }", "query"],
	] as const) {
		writeFileSync(source, text);
		const request = { kind: "api", endpoint, method: endpoint === "graphql" ? "POST" : "PATCH",
			...(field ? { fields: [{ name: field, file: source }] } : { bodyFile: source }) };
		const result = await publish(request, safeContext, mocks);
		code(result, "invalid-request");
		assert.match(result.detail!, /append-only/);
	}
	assert.equal(spawned, 0);
}));
test("captured metadata-only issue updates and PR descriptions remain publishable", () => fixture(async root => {
	const source = join(root, "input.json");
	const sent: string[] = [];
	const mocks = adapters((_executable, argv) => {
		sent.push(readFileSync(argv.find(arg => arg.startsWith("--input="))!.slice("--input=".length), "utf8"));
		const child = new Child(); queueMicrotask(() => child.finish()); return child;
	});
	for (const [endpoint, text] of [["repos/o/r/issues/3", '{"state":"closed","labels":["done"]}'], ["repos/o/r/pulls/3", '{"body":"Release notes"}']]) {
		writeFileSync(source, text);
		code(await publish({ kind: "api", endpoint, method: "PATCH", bodyFile: source }, safeContext, mocks), "published");
		assert.equal(sent.at(-1), text);
	}
}));

test("release, issue and PR publication resolve absolute and home-relative body files alike", () => fixture(async root => {
	const source = join(root, "notes.md"), bytes = Buffer.from("Release notes\r\n");
	writeFileSync(source, bytes);
	const sent: Buffer[] = [];
	const mocks = adapters((_executable, argv) => {
		const slot = argv.find(arg => /^--(?:notes|body)-file=/.test(arg))!;
		sent.push(readFileSync(slot.slice(slot.indexOf("=") + 1)));
		const child = new Child(); queueMicrotask(() => child.finish()); return child;
	});
	for (const bodyFile of [source, "~/notes.md"]) for (const request of [
		{ kind: "release-create", repo: base.repo, tag: "v1" }, base, { ...base, kind: "pr-comment" },
	]) code(await publish({ ...request, bodyFile }, { home: root, cwd: dirname(root) }, mocks), "published");
	assert.deepEqual(sent, Array(6).fill(bytes));
}));

test("pr-edit sends scanned body bytes as a REST PATCH while retaining title, base and host", () => fixture(async root => {
	const source = join(root, "notes.md"), bytes = Buffer.from("\ufeffFirst line\r\n@second line");
	writeFileSync(source, bytes);
	const calls: string[][] = [], sent: Buffer[] = [];
	const mocks = adapters((_executable, argv) => {
		calls.push(argv);
		const slot = argv.find(arg => arg.startsWith("--field=body=@"));
		if (slot) sent.push(readFileSync(slot.slice("--field=body=@".length)));
		const child = new Child(); queueMicrotask(() => child.finish()); return child;
	});
	const request = { ...base, kind: "pr-edit", title: "@literal", base: "main" };
	code(await publish({ ...request, bodyFile: "~/notes.md", host: "ghe.example.com" }, { home: root }, mocks), "published");
	code(await publish({ ...request, body: "" }, safeContext, mocks), "published");
	assert.deepEqual(calls[0], ["auth", "status", "--hostname=ghe.example.com"]);
	for (const [index, host] of [[1, "ghe.example.com"], [2, "github.com"]] as const) {
		const argv = calls[index];
		assert.deepEqual(argv.slice(0, 4), ["api", "repos/owner/repo/pulls/39", "--method=PATCH", `--hostname=${host}`]);
		assert.ok(argv.includes("--raw-field=title=@literal"));
		assert.ok(argv.includes("--raw-field=base=main"));
		assert.ok(!argv.some(arg => arg.includes(source)));
	}
	assert.deepEqual(sent, [bytes, Buffer.alloc(0)]);
	writeFileSync(source, "/home/scanner-fixture/private-value");
	code(await publish({ ...request, bodyFile: source }, safeContext, mocks), "scan-refused");
	assert.equal(calls.length, 3);
}));

test("metadata-only PR edits use REST without replacing other metadata", async () => {
	const calls: string[][] = [];
	const mocks = adapters((_executable, argv) => {
		calls.push(argv);
		const child = new Child(); queueMicrotask(() => child.finish()); return child;
	});
	code(await publish({ ...base, kind: "pr-edit", addLabels: ["ai-corpus: tracked", "documentation"], removeLabels: ["old/review #1"],
		addAssignees: ["incoming"], removeAssignees: ["outgoing"], addReviewers: ["writer", "Owner/new-team"],
		removeReviewers: ["reader", "owner/old-team"] }, safeContext, mocks), "published");
	const issue = "repos/owner/repo/issues/39", reviews = "repos/owner/repo/pulls/39/requested_reviewers";
	assert.ok(calls.every(args => args[0] === "api" && args.includes("--hostname=github.com")));
	assert.deepEqual(calls.map(args => [args[1], args[2], ...args.filter(arg => arg.startsWith("--raw-field="))]), [
		["repos/owner/repo/pulls/39", "--method=GET"],
		[`${issue}/labels/old%2Freview%20%231`, "--method=DELETE"],
		[`${issue}/labels`, "--method=POST", "--raw-field=labels[]=ai-corpus: tracked", "--raw-field=labels[]=documentation"],
		[`${issue}/assignees`, "--method=DELETE", "--raw-field=assignees[]=outgoing"],
		[reviews, "--method=DELETE", "--raw-field=reviewers[]=reader", "--raw-field=team_reviewers[]=old-team"],
		[`${issue}/assignees`, "--method=POST", "--raw-field=assignees[]=incoming"],
		[reviews, "--method=POST", "--raw-field=reviewers[]=writer", "--raw-field=team_reviewers[]=new-team"],
	]);
});

test("PR metadata edits cannot change an ordinary issue with the requested number", async () => {
	const calls: string[][] = [];
	const mocks = adapters((_executable, argv) => {
		calls.push(argv);
		const child = new Child(); queueMicrotask(() => child.finish(1)); return child;
	});
	code(await publish({ ...base, kind: "pr-edit", addLabels: ["triaged"] }, safeContext, mocks), "gh-failed");
	assert.deepEqual(calls.map(args => args.slice(0, 3)), [["api", "repos/owner/repo/pulls/39", "--method=GET"]]);
});

test("unsafe metadata in a later REST operation prevents every mutation", async () => {
	let spawned = 0;
	const mocks = adapters(() => { spawned++; throw new Error("must not reach gh"); });
	code(await publish({ ...base, kind: "pr-edit", addLabels: ["triaged"],
		addAssignees: [`${safeContext.home}/private-value`] }, safeContext, mocks), "scan-refused");
	assert.equal(spawned, 0);
});

test("pr-edit with non-REST metadata still uses native gh options", async () => {
	let args: string[] = [];
	const mocks = adapters((_executable, argv) => {
		args = argv;
		const child = new Child(); queueMicrotask(() => child.finish()); return child;
	});
	code(await publish({ ...base, kind: "pr-edit", body: "New description", addReviewers: ["reviewer"] }, safeContext, mocks), "published");
	assert.deepEqual(args.slice(0, 3), ["pr", "edit", "39"]);
	assert.ok(args.includes("--add-reviewer=reviewer"));
	assert.ok(args.some(arg => arg.startsWith("--body-file=")));
});

for (const [reason, stateReason, initialState, comment] of [
	["not-planned", "not_planned", "open", "text"], ["completed", "completed", "open", "none"],
	["not-planned", "not_planned", "closed", "text"], [undefined, undefined, "open", "text"],
	[undefined, undefined, "closed", "none"], [undefined, undefined, "open", "blank"],
] as const) {
	test(`issue close (${reason ?? "default reason"}, ${initialState}, ${comment} body)`, () => fixture(async root => {
		const endpoint = "repos/owner/repo/issues/39";
		const source = join(root, "close.md"), body = Buffer.from(comment === "blank" ? " \t\r\n" : "\ufeffClosing note\r\n@next line");
		writeFileSync(source, body);
		const calls: string[][] = [], comments: Buffer[] = [];
		const mocks = adapters((_executable, argv) => {
			calls.push(argv);
			const child = new Child();
			queueMicrotask(() => {
				if (argv[2] === "--method=GET") child.stdout.write(`${initialState}\n`);
				else if (argv[1] === `${endpoint}/comments`) {
					const field = argv.find(arg => arg.startsWith("--field=body=@"));
					if (field) comments.push(readFileSync(field.slice("--field=body=@".length)));
				} else child.stdout.write("true\n");
				child.finish();
			});
			return child;
		});
		code(await publish({ ...base, kind: "issue-close", ...(reason ? { reason } : {}),
			...(comment === "none" ? {} : { bodyFile: source }) }, safeContext, mocks), "published");
		const shouldComment = initialState === "open" && comment === "text", shouldClose = initialState === "open" || reason;
		assert.deepEqual(calls.map(args => args.slice(0, 3)), [
			["api", endpoint, "--method=GET"],
			...(shouldComment ? [["api", `${endpoint}/comments`, "--method=POST"]] : []),
			...(shouldClose ? [["api", endpoint, "--method=PATCH"]] : []),
		]);
		assert.deepEqual(comments, shouldComment ? [body] : []);
		if (shouldClose) {
			const patch = calls.at(-1)!;
			assert.ok(patch.includes("--raw-field=state=closed"));
			assert.deepEqual(patch.filter(arg => arg.startsWith("--raw-field=state_reason=")), stateReason ? [`--raw-field=state_reason=${stateReason}`] : []);
			assert.ok(patch.includes(`--jq=.state == "closed"${stateReason ? ` and .state_reason == "${stateReason}"` : ""}`));
		}
	}));
}

for (const [request, label] of [[{ reason: "not-planned" }, "without a comment"], [{ body: "Closing note" }, "with a comment"]] as const) {
	test(`issue-close refuses a pull request before mutation (${label})`, async () => {
		const calls: string[][] = [];
		const mocks = adapters((_executable, argv) => {
			calls.push(argv);
			const child = new Child();
			queueMicrotask(() => { child.stdout.write("pr\n"); child.finish(); });
			return child;
		});
		code(await publish({ ...base, kind: "issue-close", ...request }, safeContext, mocks), "gh-failed", "target is a pull request; use pr-close instead");
		assert.deepEqual(calls.map(args => args.slice(0, 3)), [["api", "repos/owner/repo/issues/39", "--method=GET"]]);
		assert.ok(calls[0].includes('--jq=if has("pull_request") then "pr" else .state end'));
	});
}

for (const [failure, failureCode, advice, step] of [
	["unsafe comment", "scan-refused", undefined, undefined],
	["comment exits nonzero", "gh-failed", "check the issue before retrying", "POST"],
	["comment times out", "gh-timeout", "check the issue before retrying", "POST"],
	["close exits nonzero", "gh-failed", "comment already posted; retry issue-close without body", "PATCH"],
	["close is unconfirmed", "gh-failed", "comment already posted; retry issue-close without body", "PATCH"],
] as const) {
	test(`issue close handles ${failure} without retrying the comment`, async () => {
		const calls: string[] = [];
		let timeout: () => void;
		const mocks = adapters((_executable, argv) => {
			const method = argv[2].slice("--method=".length);
			calls.push(method);
			const child = new Child();
			queueMicrotask(() => {
				if (method === "GET") child.stdout.write("open\n");
				if (method !== step) return child.finish();
				if (failure === "comment times out") { timeout(); return child.finish(null); }
				if (failure === "close is unconfirmed") { child.stdout.write("false\n"); return child.finish(); }
				child.stderr.write("gh: Server error (HTTP 503)\n");
				child.finish(1);
			});
			return child;
		});
		mocks.clock = { after: (_ms, callback) => { timeout = callback; return () => {}; } };
		const body = step ? "Closing note" : `${safeContext.home}/private-value`;
		const result = await publish({ ...base, kind: "issue-close", reason: "not-planned", body }, safeContext, mocks);
		code(result, failureCode, advice);
		assert.deepEqual(calls, step ? ["GET", "POST", ...(step === "PATCH" ? ["PATCH"] : [])] : []);
	});
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

for (const [errno, expected, detail] of [
	["ENOENT", "payload-not-found"], ["ENOTDIR", "payload-not-found"], ["ELOOP", "payload-symlink"],
	["EISDIR", "payload-not-file"], ["EACCES", "payload-permission"], ["EPERM", "payload-permission"],
	["EIO", "payload-unreadable", "code=EIO"], ["EPRIVATE_VALUE", "payload-unreadable"],
	["ENOENT\n", "payload-unreadable"], ["toString", "payload-unreadable"], [undefined, "payload-unreadable"],
] as const) test(`open errno ${JSON.stringify(errno)} uses only whitelisted code and caller path`, async () => {
	const mocks = adapters(); let opened = "";
	mocks.io!.open = async path => { opened = path; throw Object.assign(new Error("private-value"), { code: errno, path: "private-value" }); };
	const result = await publish({ ...base, bodyFile: "draft.md" }, { ...safeContext, cwd: "/workspace/project" }, mocks);
	assert.equal(opened, "/workspace/project/draft.md");
	code(result, expected, expected === "payload-unreadable" ? detail : "/workspace/project/draft.md");
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

test("oversize descriptors name the resolved caller path; read and close show only safe errno codes", async () => {
	const mocks = adapters(); mocks.io!.open = async () => fakeHandle({ size: MAX_STRING_BYTES + 1 }).handle;
	const context = { ...safeContext, cwd: "/workspace/project" };
	const result = await publish({ ...base, bodyFile: "draft.md" }, context, mocks);
	code(result, "payload-too-large", "/workspace/project/draft.md");
	for (const operation of ["read", "close"] as const) for (const [errno, detail] of [["ENOENT", "code=ENOENT"], ["EPRIVATE_VALUE", undefined]] as const) {
		const file = fakeHandle(); file.handle[operation] = async () => { throw Object.assign(new Error("private-value"), { code: errno, path: "private-value" }); };
		mocks.io!.open = async () => file.handle;
		const failed = await publish({ ...base, bodyFile: "draft.md" }, context, mocks);
		code(failed, "payload-unreadable", detail);
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
] as const) test(`gh stderr classifies ${category} without echoing reflected content`, async () => {
	const mocks = adapters(() => {
		const child = new Child(); queueMicrotask(() => {
			child.stdout.write("HTTP 401: Bad credentials");
			child.stderr.emit("data", Buffer.from(message.slice(0, 8)));
			child.stderr.emit("data", message.slice(8) + " private-value PAYLOAD-SENTINEL"); child.finish(1);
		}); return child;
	});
	const result = await publish({ ...base, body: "PAYLOAD-SENTINEL" }, safeContext, mocks);
	code(result, "gh-failed");
	const status = message.match(/HTTP (\d{3})/)?.[1];
	assert.equal(result.detail, `exit=1 category=${category}${status ? `; status=${status}` : ""}; ${advice}`);
	assert.doesNotMatch(JSON.stringify(result), /PAYLOAD-SENTINEL|private-value/);
});

for (const [endpoint, status, hasHint] of [
	["repos/owner/repo/security-advisories", 404, true],
	["/repos/owner/repo/security-advisories/GHSA-example/forks?per_page=10", 404, true],
	["repos/owner/repo/security-advisories-extra", 404, false],
	["repos/owner/repo/security-advisories", 403, false],
] as const) test(`api HTTP ${status} at ${endpoint} ${hasHint ? "includes" : "omits"} private advisory guidance`, async () => {
	const mocks = adapters(() => {
		const child = new Child(); queueMicrotask(() => { child.stderr.write(`gh: Request failed (HTTP ${status})`); child.finish(1); }); return child;
	});
	const result = await publish({ kind: "api", endpoint, method: "POST" }, safeContext, mocks);
	code(result, "gh-failed");
	assert.match(result.detail!, new RegExp(`^exit=1 category=${status === 404 ? "not-found" : "auth"}; status=${status}; message="Request failed"; do not retry`));
	const hint = /private repositories.*report the vulnerability privately/i;
	if (hasHint) assert.match(result.detail!, hint);
	else assert.doesNotMatch(result.detail!, hint);
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
			const bytes = Buffer.from("é HTTP 422 Validation Failed private-value");
			for (const byte of bytes) child.stderr.emit("data", Buffer.from([byte]));
			child.finish(3);
		}); return child;
	});
	const result = await publish({ ...base, body: "Safe" }, safeContext, mocks);
	code(result, "gh-failed"); assert.equal(result.detail, "exit=3 category=validation; status=422; do not retry; fix the request (repo, number, fields)");
	assert.ok(!JSON.stringify(result).includes("private-value"));
});

test("gh diagnostics expose bounded API messages for native and gh api error formats", async () => {
	for (const [stderr, message, status] of [
		["GraphQL: Projects (classic) is being deprecated (repository.pullRequest.projectCards)", "Projects (classic) is being deprecated", undefined],
		["HTTP 422: Base branch is invalid (https://api.github.com/repos/o/r/pulls/39)", "Base branch is invalid", "422"],
		["gh: Base branch is invalid (HTTP 422)", "Base branch is invalid", "422"],
	] as const) {
		const mocks = adapters(() => {
			const child = new Child(); queueMicrotask(() => { child.stderr.write(stderr); child.finish(1); }); return child;
		});
		const result = await publish({ ...base, kind: "pr-edit", body: "New description" }, safeContext, mocks);
		code(result, "gh-failed");
		assert.ok(result.detail?.includes("exit=1"));
		assert.ok(result.detail?.includes("message="));
		assert.ok(result.detail?.includes(message));
		assert.equal(result.detail?.match(/status=(\d+)/)?.[1], status);
		assert.ok(!result.detail?.includes("https://api.github.com"));
	}
});

test("native gh diagnostics omit private paths, reflected body lines and unrelated stderr", async () => {
	for (const message of ["GraphQL: /home/scanner-fixture/private-value", "HTTP 422: error in Reflected body", "private-value"]) {
		const mocks = adapters(() => {
			const child = new Child(); queueMicrotask(() => { child.stderr.write(message + "\nunrelated diagnostic"); child.finish(1); }); return child;
		});
		const result = await publish({ ...base, kind: "pr-edit", body: "Reflected body" }, safeContext, mocks);
		code(result, "gh-failed");
		assert.doesNotMatch(result.detail!, /message=|private-value|Reflected body|unrelated diagnostic/);
	}
});

test("successful gh exit never exposes or classifies stderr", async () => {
	const mocks = adapters(() => {
		const child = new Child(); queueMicrotask(() => { child.stderr.write("HTTP 401 private-value"); child.finish(0); }); return child;
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
