import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidRequest, MAX_STRING_BYTES, parseCli, publishRequestSchema, toGhPlan, validateRequest } from "./publish-request.ts";
import type { PublishRequest } from "./publish-request.ts";

const target = { repo: "owner/repo", number: 39 };
const cases: PublishRequest[] = [
	{ kind: "issue-create", repo: target.repo, title: "Title", body: "Body" },
	{ kind: "pr-create", repo: target.repo, title: "Title", bodyFile: "draft.md", base: "main", head: "feature/topic", draft: true },
	{ kind: "issue-comment", ...target, body: "Body", editLast: true, createIfNone: true },
	{ kind: "pr-comment", ...target, bodyFile: "draft.md" },
	{ kind: "issue-edit", ...target, title: "Updated" },
	{ kind: "pr-edit", ...target, body: "Body", base: "main", addReviewers: ["person"] },
	{ kind: "issue-close", ...target, bodyFile: "comment.md", reason: "completed" },
	{ kind: "pr-close", ...target, body: "Bye", deleteBranch: true },
	{ kind: "issue-reopen", ...target, body: "Again" },
	{ kind: "pr-reopen", ...target, bodyFile: "comment.md" },
	{ kind: "pr-review", ...target, event: "approve" },
	{ kind: "pr-merge", ...target, strategy: "squash", body: "Body", subject: "Subject", auto: true, matchHeadCommit: "a".repeat(40) },
	{ kind: "release-create", repo: target.repo, tag: "v1.0", body: "Notes", target: "main", prerelease: true },
	{ kind: "release-notes", repo: target.repo, tag: "v1.0", title: "Updated" },
	{ kind: "gist-create", files: ["one/file.md", "two/file.md"], description: "Description", public: true },
	{ kind: "gist-edit", gistId: "abc123", files: ["file.md"] },
	{ kind: "gist-edit", gistId: "abc123", removeFiles: ["old.md"] },
	{ kind: "gist-edit", gistId: "abc123", description: "New description" },
	{ kind: "api", endpoint: "repos/owner/repo/issues", method: "POST", body: "{}", fields: [{ name: "literal", value: "@not-a-file" }, { name: "count", value: 2 }, { name: "enabled", value: true }, { name: "empty", value: null }, { name: "file", file: "input.json" }] },
	{ kind: "check", files: ["draft.md"] },
];
for (const request of cases) test(`validates and plans ${request.kind}`, () => {
	assert.deepEqual(validateRequest(request), request);
	const plan = toGhPlan(request);
	assert.equal(plan.authority.kind, request.kind);
	assert.ok(plan.argv.every(arg => typeof arg === "string" || Number.isSafeInteger(arg.payload)));
	assert.ok(plan.payloads.every(source => /^(?:body|files\[\d+\]|fields\[\d+\])$/.test(source.label)));
});

test("request and nested arrays detach and freeze; caller mutation cannot alter authority", () => {
	const request = { kind: "issue-create", repo: target.repo, title: "Title", body: "Body", labels: ["safe"] };
	const validated = validateRequest(request);
	request.repo = "other/repo"; request.labels[0] = "changed";
	assert.equal("repo" in validated && validated.repo, target.repo);
	assert.equal(Object.isFrozen(validated), true);
	assert.ok("labels" in validated && Object.isFrozen(validated.labels));
});

const bad = [
	null, [], "publish", {}, { kind: "--help" }, { kind: "issue-delete", ...target },
	{ kind: "api", endpoint: "https://evil.invalid/", method: "POST" },
	{ kind: "api", endpoint: "//evil.invalid/", method: "POST" },
	{ kind: "api", endpoint: "repos/../secrets", method: "POST" },
	{ kind: "api", endpoint: "repos/%2e%2e/secrets", method: "POST" },
	{ kind: "api", endpoint: "%2F%2Fevil.invalid/path", method: "POST" },
	{ kind: "api", endpoint: "repos/o/r%00", method: "POST" },
	{ kind: "api", endpoint: "repos/o/r%ZZ", method: "POST" },
	{ kind: "api", endpoint: "repos/o/r", method: "GET" },
	{ kind: "issue-create", repo: target.repo, title: "Title" },
	{ kind: "issue-comment", ...target, body: "Body", bodyFile: "draft.md" },
	{ kind: "issue-comment", ...target, body: "Body", createIfNone: true },
	{ kind: "pr-review", ...target, event: "request-changes" },
	{ kind: "issue-close", ...target, reason: "other" },
	{ kind: "pr-merge", ...target, strategy: "admin" },
	{ kind: "release-create", repo: target.repo, tag: "v1" },
	{ kind: "release-notes", repo: target.repo, tag: "v1" },
	{ kind: "issue-edit", ...target, addLabels: ["only-label"] },
	{ kind: "gist-create", files: [] }, { kind: "gist-create", files: ["dir/-flag"] },
	{ kind: "gist-edit", gistId: "-bad", description: "Body" },
	{ kind: "gist-edit", gistId: "abc", files: [], removeFiles: [] },
	{ kind: "gist-edit", gistId: "abc", files: ["a.md", "b.md"] }, { kind: "gist-edit", gistId: "abc", removeFiles: ["a.md", "b.md"] },
	{ kind: "gist-edit", gistId: "abc", files: ["a.md"], removeFiles: ["b.md"] }, { kind: "gist-edit", gistId: "abc", files: ["a.md"], description: "d" },
	{ kind: "gist-edit", gistId: "abc", removeFiles: ["b.md"], description: "d" }, { kind: "gist-edit", gistId: "abc" },
	{ kind: "gist-edit", gistId: "abc", removeFiles: ["../file"] },
	{ kind: "check", files: [] }, { kind: "check", files: ["a"], scanOverride: true },
];
for (const [index, value] of bad.entries()) test(`rejects invalid operation fixture ${index} without received values`, () => {
	assert.throws(() => validateRequest(value), error => {
		assert.ok(error instanceof InvalidRequest);
		assert.equal(error.message, "publish: invalid-request");
		assert.deepEqual(Object.keys(error), ["code"]);
		return true;
	});
});
for (const key of ["args", "shell", "env", "executable", "headers", "bodyFile", "number", "reason", "public", "kindd"]) test(`rejects irrelevant/unknown field ${key}`, () => {
	assert.throws(() => validateRequest({ kind: "check", files: ["a"], [key]: "private-value" }), InvalidRequest);
});
for (const value of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "39", "https://github.com/o/r/issues/39"]) test(`rejects nonpositive/noninteger target fixture ${String(value)}`, () => {
	assert.throws(() => validateRequest({ kind: "issue-close", ...target, number: value }), InvalidRequest);
});
for (const repo of ["-owner/repo", "owner/-repo", "owner/repo\n", "owner/repo/other", "https://github.com/o/r", "owner\0/repo"]) test("rejects non-repository syntax", () => {
	assert.throws(() => validateRequest({ kind: "issue-close", repo, number: 1 }), InvalidRequest);
});

test("field objects enforce strict xor, primitive values, safe names and finite numbers", () => {
	for (const field of [{ name: "x", value: "v", file: "f" }, { name: "x" }, { name: "x", value: {} }, { name: "x", value: NaN }, { name: "x", file: "f", extra: true }, { name: "bad=name", value: "v" }]) {
		assert.throws(() => validateRequest({ kind: "api", endpoint: "repos/o/r", method: "PATCH", fields: [field] }), InvalidRequest);
	}
});

test("per-string byte and item limits do not trust character counts", () => {
	assert.throws(() => validateRequest({ kind: "issue-comment", ...target, body: "é".repeat(MAX_STRING_BYTES / 2 + 1) }), InvalidRequest);
	assert.throws(() => validateRequest({ kind: "check", files: Array(101).fill("a") }), InvalidRequest);
	assert.throws(() => validateRequest({ kind: "issue-comment", ...target, body: "\ud800" }), InvalidRequest);
	assert.throws(() => validateRequest({ kind: "api", endpoint: "repos/o/r", method: "POST", fields: Array.from({ length: 5 }, () => ({ name: "x", value: "a".repeat(MAX_STRING_BYTES) })) }), InvalidRequest);
});

test("schema exposes a strict per-kind object contract with no arbitrary selectors", () => {
	assert.equal(publishRequestSchema.type, "object");
	assert.equal(publishRequestSchema.additionalProperties, false);
	assert.equal(publishRequestSchema.oneOf.length, 18);
	for (const shape of publishRequestSchema.oneOf) {
		assert.equal(shape.additionalProperties, false);
		assert.ok(shape.allOf.some(rule => "not" in rule));
	}
	const create = publishRequestSchema.oneOf.find(shape => shape.properties.kind.const === "issue-create")!;
	assert.ok(create.allOf.some(rule => JSON.stringify(rule) === JSON.stringify({ anyOf: [{ required: ["body"] }, { required: ["bodyFile"] }] })));
});

test("check has capture sources but no gh command or authority argv", () => {
	const plan = toGhPlan({ kind: "check", files: ["a", "b"] });
	assert.deepEqual(plan.argv, []); assert.deepEqual(plan.authority.ghArgs, []);
	assert.equal(plan.payloads.length, 2); assert.deepEqual(plan.outbound, []);
});

test("detached request is validated again if a caller accessor changes identifier values", () => {
	let reads = 0;
	const value = { kind: "issue-close", number: 39, get repo() { return ++reads === 1 ? "owner/repo" : "--invalid"; } };
	assert.throws(() => validateRequest(value), InvalidRequest);
});

test("body and file fields are slots, not original paths or gh @ interpretations", () => {
	const plan = toGhPlan(cases.find(request => request.kind === "api")!);
	assert.ok(plan.argv.includes("--raw-field=literal=@not-a-file"));
	for (const field of ["count=2", "enabled=true", "empty=null"]) assert.ok(plan.argv.includes(`--field=${field}`));
	assert.ok(plan.argv.includes("--hostname=github.com"));
	assert.ok(plan.argv.includes("--header=Content-Type: application/json"));
	assert.ok(plan.argv.some(arg => typeof arg !== "string" && arg.prefix === "--field=file=@"));
	assert.ok(!plan.authority.ghArgs.some(arg => arg.includes("input.json")));
	assert.ok(plan.payloads.some(source => "file" in source.source && source.source.file === "input.json"));
});

test("reopen and close comments are scanned text slots; merge/release use files", () => {
	for (const kind of ["issue-close", "issue-reopen", "pr-close", "pr-reopen"] as const) {
		const plan = toGhPlan({ kind, ...target, bodyFile: "private-name" });
		assert.deepEqual(plan.argv.at(-1), { payload: 0, use: "text", prefix: "--comment=" });
		assert.ok(!JSON.stringify(plan.authority).includes("private-name"));
	}
	assert.ok(toGhPlan(cases[12]).argv.some(arg => typeof arg !== "string" && arg.prefix === "--notes-file="));
	assert.deepEqual(toGhPlan(cases[13]).argv.slice(0, 3), ["release", "edit", "v1.0"]);
});

test("safe named arguments cannot become flags and canonical authority retains exact targets", () => {
	const plan = toGhPlan({ kind: "pr-create", repo: target.repo, title: "--flag", body: "Body", base: "main", head: "owner:topic", labels: ["--admin"], reviewers: ["person"] });
	assert.ok(plan.argv.includes("--title=--flag"));
	assert.ok(plan.argv.includes("--label=--admin"));
	assert.equal(plan.authority.repo, target.repo);
	assert.equal(plan.authority.head, "owner:topic");
	assert.equal(plan.authority.base, "main");
});

test("CLI mechanically maps repeatable arrays, booleans and field JSON without shell parsing", () => {
	assert.deepEqual(parseCli(["issue-comment", "--repo", target.repo, "--number", "39", "--body", "--help", "--edit-last", "--create-if-none"]), { kind: "issue-comment", ...target, body: "--help", editLast: true, createIfNone: true });
	assert.deepEqual(parseCli(["gist-create", "--file", "a", "--file", "b", "--public"]), { kind: "gist-create", files: ["a", "b"], public: true });
	assert.deepEqual(parseCli(["api", "--endpoint", "repos/o/r", "--method", "PATCH", "--field-json", '{"name":"a","value":"@literal"}']), { kind: "api", endpoint: "repos/o/r", method: "PATCH", fields: [{ name: "a", value: "@literal" }] });
	assert.deepEqual(parseCli(["--help"]), { kind: "help" });
});
for (const argv of [[], ["--help", "issue-close"], ["check", "--help"], ["check", "--file=a"], ["check", "-f", "a"], ["check", "--file"], ["check", "--file", "a", "extra"], ["issue-close", "--repo", target.repo, "--repo", target.repo, "--number", "1"], ["issue-close", "--repo", target.repo, "--number", "1e2"], ["api", "--endpoint", "repos/o/r", "--method", "POST", "--field-json", "invalid"]]) test("CLI refuses malformed/combined/unknown flags and nonstandalone help", () => {
	assert.throws(() => parseCli(argv), InvalidRequest);
});

test("gist-edit plans exactly one single-valued gh operation (--add, --remove or --desc)", () => {
	const gist = (extra: object) => toGhPlan(validateRequest({ kind: "gist-edit", gistId: "abc123", ...extra })).argv;
	assert.deepEqual(gist({ removeFiles: ["old.md"] }), ["gist", "edit", "abc123", "--remove=old.md"]);
	assert.deepEqual(gist({ description: "New" }), ["gist", "edit", "abc123", "--desc=New"]);
	assert.deepEqual(gist({ files: ["file.md"] }), ["gist", "edit", "abc123", { payload: 0, use: "file", prefix: "--add=" }]);
	const edit = publishRequestSchema.oneOf.find(shape => shape.properties.kind.const === "gist-edit")! as any;
	assert.equal(edit.allOf.at(-1).oneOf.length, 3);
});
