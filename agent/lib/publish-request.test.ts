import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidRequest, kindContract, MAX_STRING_BYTES, parseCli, publishRequestSchema, toGhPlan, validateRequest } from "./publish-request.ts";
import publishExtension from "../extensions/publish.ts";
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

for (const abbreviated of ["abcd", "abc1234", "A".repeat(39)]) test(`release target rejects ${abbreviated.length}-character abbreviated SHA without echoing it`, () => {
	assert.throws(() => validateRequest({ kind: "release-create", repo: target.repo, tag: "v1", body: "Notes", target: abbreviated }), (error: unknown) => {
		assert.ok(error instanceof InvalidRequest);
		assert.match(error.detail!, /abbreviated commit SHA; use the full 40-character SHA or a branch name/);
		assert.ok(!error.detail!.includes(abbreviated));
		return true;
	});
});
for (const fullTarget of ["a".repeat(40), "main", "v1.0", "release/1.2", "feature-1234abcd"]) test(`release target accepts ${fullTarget}`, () => {
	assert.equal(validateRequest({ kind: "release-create", repo: target.repo, tag: "v1", body: "Notes", target: fullTarget }).kind, "release-create");
});

for (const name of ["vulnerabilities[][package][name]", "x[][a]"]) test(`api fields reject nested array name without echoing it: ${name}`, () => {
	assert.throws(() => validateRequest({ kind: "api", endpoint: "repos/o/r", method: "POST", fields: [{ name, value: "VALUE-SENTINEL" }] }), (error: unknown) => {
		assert.ok(error instanceof InvalidRequest);
		assert.match(error.detail!, /fields cannot build arrays of objects/);
		assert.match(error.detail!, /JSON in a bodyFile with no fields/);
		assert.ok(!error.detail!.includes(name)); assert.ok(!error.detail!.includes("VALUE-SENTINEL"));
		return true;
	});
});
for (const name of ["labels[]", "a[b]", "a.b"]) test(`api fields keep scalar/nested object syntax: ${name}`, () => {
	const request = { kind: "api", endpoint: "repos/o/r", method: "POST", fields: [{ name, value: "value" }] };
	assert.deepEqual(validateRequest(request), request);
	assert.ok(toGhPlan(validateRequest(request)).argv.includes(`--raw-field=${name}=value`));
});

const minimalCases: Record<string, unknown>[] = [
	{ kind: "issue-create", repo: target.repo, title: "T", body: "B" },
	{ kind: "pr-create", repo: target.repo, title: "T", body: "B" },
	{ kind: "issue-comment", ...target, body: "B" }, { kind: "pr-comment", ...target, body: "B" },
	{ kind: "issue-edit", ...target, title: "T" }, { kind: "pr-edit", ...target, title: "T" },
	{ kind: "issue-close", ...target }, { kind: "pr-close", ...target },
	{ kind: "issue-reopen", ...target }, { kind: "pr-reopen", ...target },
	{ kind: "pr-review", ...target, event: "approve" }, { kind: "pr-merge", ...target, strategy: "merge" },
	{ kind: "release-create", repo: target.repo, tag: "v1", body: "B" },
	{ kind: "release-notes", repo: target.repo, tag: "v1", title: "T" },
	{ kind: "gist-create", files: ["a.md"] }, { kind: "gist-edit", gistId: "abc", description: "D" },
	{ kind: "api", endpoint: "repos/o/r", method: "POST" }, { kind: "check", files: ["a.md"] },
];
// Pinned from ee0ed8f1's oneOf schema + validateRequest, not the current runtime contracts.
const parityFields: Record<string, { required: string; forbidden: string }> = {
	"issue-create": { required: "repo title", forbidden: "addAssignees addLabels addReviewers auto base createIfNone deleteBranch description draft editLast endpoint event fields files gistId head matchHeadCommit method number prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject tag target" },
	"pr-create": { required: "repo title", forbidden: "addAssignees addLabels addReviewers auto createIfNone deleteBranch description editLast endpoint event fields files gistId matchHeadCommit method number prerelease public reason removeAssignees removeFiles removeLabels removeReviewers strategy subject tag target" },
	"issue-comment": { required: "repo number", forbidden: "addAssignees addLabels addReviewers assignees auto base deleteBranch description draft endpoint event fields files gistId head labels matchHeadCommit method prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject tag target title" },
	"pr-comment": { required: "repo number", forbidden: "addAssignees addLabels addReviewers assignees auto base deleteBranch description draft endpoint event fields files gistId head labels matchHeadCommit method prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject tag target title" },
	"issue-edit": { required: "repo number", forbidden: "addReviewers assignees auto base createIfNone deleteBranch description draft editLast endpoint event fields files gistId head labels matchHeadCommit method prerelease public reason removeFiles removeReviewers reviewers strategy subject tag target" },
	"pr-edit": { required: "repo number", forbidden: "assignees auto createIfNone deleteBranch description draft editLast endpoint event fields files gistId head labels matchHeadCommit method prerelease public reason removeFiles reviewers strategy subject tag target" },
	"issue-close": { required: "repo number", forbidden: "addAssignees addLabels addReviewers assignees auto base createIfNone deleteBranch description draft editLast endpoint event fields files gistId head labels matchHeadCommit method prerelease public removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject tag target title" },
	"pr-close": { required: "repo number", forbidden: "addAssignees addLabels addReviewers assignees auto base createIfNone description draft editLast endpoint event fields files gistId head labels matchHeadCommit method prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject tag target title" },
	"issue-reopen": { required: "repo number", forbidden: "addAssignees addLabels addReviewers assignees auto base createIfNone deleteBranch description draft editLast endpoint event fields files gistId head labels matchHeadCommit method prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject tag target title" },
	"pr-reopen": { required: "repo number", forbidden: "addAssignees addLabels addReviewers assignees auto base createIfNone deleteBranch description draft editLast endpoint event fields files gistId head labels matchHeadCommit method prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject tag target title" },
	"pr-review": { required: "repo number event", forbidden: "addAssignees addLabels addReviewers assignees auto base createIfNone deleteBranch description draft editLast endpoint fields files gistId head labels matchHeadCommit method prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject tag target title" },
	"pr-merge": { required: "repo number strategy", forbidden: "addAssignees addLabels addReviewers assignees base createIfNone description draft editLast endpoint event fields files gistId head labels method prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers tag target title" },
	"release-create": { required: "repo tag", forbidden: "addAssignees addLabels addReviewers assignees auto base createIfNone deleteBranch description editLast endpoint event fields files gistId head labels matchHeadCommit method number public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject" },
	"release-notes": { required: "repo tag", forbidden: "addAssignees addLabels addReviewers assignees auto base createIfNone deleteBranch description draft editLast endpoint event fields files gistId head labels matchHeadCommit method number prerelease public reason removeAssignees removeFiles removeLabels removeReviewers reviewers strategy subject target" },
	"gist-create": { required: "files", forbidden: "addAssignees addLabels addReviewers assignees auto base body bodyFile createIfNone deleteBranch draft editLast endpoint event fields gistId head host labels matchHeadCommit method number prerelease reason removeAssignees removeFiles removeLabels removeReviewers repo reviewers strategy subject tag target title" },
	"gist-edit": { required: "gistId", forbidden: "addAssignees addLabels addReviewers assignees auto base body bodyFile createIfNone deleteBranch draft editLast endpoint event fields head host labels matchHeadCommit method number prerelease public reason removeAssignees removeLabels removeReviewers repo reviewers strategy subject tag target title" },
	api: { required: "endpoint method", forbidden: "addAssignees addLabels addReviewers assignees auto base createIfNone deleteBranch description draft editLast event files gistId head labels matchHeadCommit number prerelease public reason removeAssignees removeFiles removeLabels removeReviewers repo reviewers strategy subject tag target title" },
	check: { required: "files", forbidden: "addAssignees addLabels addReviewers assignees auto base body bodyFile createIfNone deleteBranch description draft editLast endpoint event fields gistId head host labels matchHeadCommit method number prerelease public reason removeAssignees removeFiles removeLabels removeReviewers repo reviewers strategy subject tag target title" },
};
// Each value is valid for its field, including conditional createIfNone: false.
const parityValues: Record<string, unknown> = {
	repo: target.repo, number: target.number, title: "T", body: "B", bodyFile: "a.md", subject: "S", description: "D",
	base: "main", head: "topic", target: "main", tag: "v1", gistId: "abc", endpoint: "repos/o/r",
	matchHeadCommit: "a".repeat(40), event: "approve", strategy: "merge", reason: "completed", method: "POST", host: "ghe.example.com",
	labels: ["safe"], assignees: ["person"], reviewers: ["person"], addLabels: ["safe"], removeLabels: ["safe"],
	addAssignees: ["person"], removeAssignees: ["person"], addReviewers: ["person"], removeReviewers: ["person"],
	draft: true, editLast: true, createIfNone: false, deleteBranch: true, auto: true, prerelease: true, public: true,
	files: ["a.md"], removeFiles: ["old.md"], fields: [{ name: "x", value: 1 }],
};
function forbiddenCases(request: Record<string, unknown>): Record<string, unknown>[] {
	return parityFields[request.kind as string].forbidden.split(" ").map(key => ({ ...request, [key]: parityValues[key] }));
}
function parityFailures(request: Record<string, unknown>): Record<string, unknown>[] {
	const pinned = parityFields[request.kind as string];
	const required = pinned.required.split(" ");
	const forbidden = pinned.forbidden.split(" ");
	const allowed = Object.keys(parityValues).filter(key => !forbidden.includes(key));
	const failures = [
		Object.fromEntries(Object.entries(request).filter(([name]) => name !== "kind")),
		{ ...request, kind: 42 }, { ...request, kind: "VALUE-SENTINEL" },
		{ ...request, zzz: "VALUE-SENTINEL" },
		...forbiddenCases(request),
		...required.map(key => Object.fromEntries(Object.entries(request).filter(([name]) => name !== key))),
	];
	for (const key of allowed) {
		const schema = (publishRequestSchema.properties as any)[key];
		const value = schema.type === "string" ? 42 : "VALUE-SENTINEL";
		failures.push({ ...request, [key]: value });
		if (schema.enum) failures.push({ ...request, [key]: "VALUE-SENTINEL" });
		if (schema.type === "integer") failures.push({ ...request, [key]: 0 }, { ...request, [key]: 1.5 });
		if (schema.type === "string" && !schema.enum) failures.push({ ...request, [key]: "a".repeat(MAX_STRING_BYTES + 1) });
		if (schema.type === "array") failures.push({ ...request, [key]: Array(101).fill(key === "fields" ? { name: "x", value: 1 } : "a") });
	}
	if (allowed.includes("body")) failures.push({ ...request, body: "B", bodyFile: "a.md" });
	if (["issue-create", "pr-create", "issue-comment", "pr-comment", "release-create"].includes(request.kind as string)) {
		failures.push(Object.fromEntries(Object.entries(request).filter(([key]) => !["body", "bodyFile"].includes(key))));
	}
	if (["issue-edit", "pr-edit", "release-notes"].includes(request.kind as string)) {
		failures.push(Object.fromEntries(Object.entries(request).filter(([key]) => !["title", "body", "bodyFile"].includes(key))));
	}
	if (allowed.includes("createIfNone")) for (const editLast of [undefined, false]) failures.push({ ...request, createIfNone: true, ...(editLast === undefined ? {} : { editLast }) });
	if (request.kind === "pr-review") for (const event of ["comment", "request-changes"]) failures.push({ ...request, event });
	if (request.kind === "gist-edit") {
		failures.push({ kind: "gist-edit", gistId: "abc" });
		for (const operations of [{ files: ["a.md"], removeFiles: ["b.md"] }, { description: "D", files: ["a.md"] }, { description: "D", removeFiles: ["b.md"] }, { files: ["a.md", "b.md"] }, { removeFiles: ["a.md", "b.md"] }, { files: [] }]) {
			failures.push({ kind: "gist-edit", gistId: "abc", ...operations });
		}
	}
	if (request.kind === "api") for (const field of [{ name: "x" }, { name: "x", value: 1, file: "a.md" }]) failures.push({ ...request, fields: [field] });
	if (allowed.includes("host")) failures.push({ ...request, host: "https://ghe.example.com" });
	if (["gist-create", "check"].includes(request.kind as string)) failures.push({ ...request, files: [] });
	return failures;
}
test("parity fixtures cover all 18 publish kinds", () => {
	assert.equal(minimalCases.length, 18);
	assert.deepEqual(Object.keys(parityFields), minimalCases.map(request => request.kind));
	assert.deepEqual(minimalCases.map(request => request.kind), publishRequestSchema.properties.kind.enum);
	for (const pinned of Object.values(parityFields)) {
		for (const key of pinned.required.split(" ")) assert.ok(key in parityValues && !pinned.forbidden.split(" ").includes(key), key);
		for (const key of pinned.forbidden.split(" ")) assert.ok(key in parityValues, key);
	}
});
for (const request of minimalCases) test(`${request.kind} preserves runtime rejection parity before admission`, async () => {
	assert.deepEqual(validateRequest(request), request);
	for (const invalid of forbiddenCases(request)) {
		const key = Object.keys(invalid).find(key => !(key in request))!;
		assert.throws(() => validateRequest(invalid), error => {
			assert.ok(error instanceof InvalidRequest);
			assert.ok(error.detail?.startsWith(`unknown field for ${request.kind}: ${key};`));
			return true;
		}, `${request.kind} must forbid valid-typed ${key}`);
	}
	let registered: any;
	publishExtension({ registerTool: (definition: unknown) => { registered = definition; } } as any, {
		admit: () => assert.fail("invalid requests must not reach authority admission"),
		candidate: async () => assert.fail("invalid requests must not reach candidate admission"),
		send: async () => assert.fail("invalid requests must not reach publication"),
	});
	for (const [index, invalid] of parityFailures(request).entries()) {
		assert.throws(() => validateRequest(invalid), error => {
			assert.ok(error instanceof InvalidRequest, `${request.kind} fixture ${index}`);
			assert.equal(error.message, "publish: invalid-request");
			assert.ok(!error.detail?.includes("SENTINEL"));
			return true;
		});
		const result = await registered.execute("id", invalid, undefined, undefined, {});
		assert.equal(result.isError, true, `${request.kind} fixture ${index}`);
		assert.equal(result.details.code, "invalid-request");
		assert.match(result.content[0].text, /^publish: invalid-request/);
		assert.ok(!JSON.stringify(result).includes("SENTINEL"));
	}
});

for (const kind of ["issue-create", "pr-create"] as const) test(`${kind} accepts exactly the .github repository name`, () => {
	const request = { kind, repo: "validorg/.github", title: "Title", body: "Body" };
	assert.deepEqual(validateRequest(request), request);
	assert.equal(toGhPlan(request).authority.repo, request.repo);
	for (const repo of ["", "owner/", "owner/..", "owner/.", "owner/.hidden", "owner/.GitHub", "owner/-repo", "owner/repo/other", "owner/.github/x", "owner/.github..", "owner/.github ", "owner/.github\t", "owner/.github\n", "owner/.github\r", "owner/.github\0", "owner/.github\u200b", "owner / .github", ".owner/.github", "-owner/.github", "own_er/.github"]) {
		assert.throws(() => validateRequest({ ...request, repo }), InvalidRequest);
	}
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
		assert.ok(Object.keys(error).every(key => ["code", "detail"].includes(key)));
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

test("schema exposes one flat strict object; runtime owns per-kind contracts", () => {
	assert.equal(publishRequestSchema.type, "object");
	assert.equal(publishRequestSchema.additionalProperties, false);
	assert.deepEqual(publishRequestSchema.required, ["kind"]);
	assert.equal((publishRequestSchema as any).oneOf, undefined);
	assert.equal(publishRequestSchema.properties.kind.enum.length, 18);
	for (const kind of publishRequestSchema.properties.kind.enum) {
		const contract = kindContract(kind as PublishRequest["kind"]);
		const required = contract.split(" requires: ")[1].split(";")[0].split(", ");
		const optional = contract.split("; optional: ")[1].split(", ").filter(Boolean);
		for (const key of [...required, ...optional]) assert.ok(key in publishRequestSchema.properties, `${kind}: ${key}`);
	}
	const inspect = (schema: any) => {
		for (const keyword of ["oneOf", "allOf", "anyOf", "if", "then", "not", "description", "maxLength", "maxItems", "pattern"]) {
			assert.ok(!(keyword in schema), keyword);
		}
		for (const property of Object.values(schema.properties ?? {})) inspect(property);
		if (schema.items) inspect(schema.items);
	};
	inspect(publishRequestSchema);
	assert.deepEqual((publishRequestSchema.properties as any).fields.items, {
		type: "object", additionalProperties: false, required: ["name"],
		properties: { name: { type: "string" }, value: { type: ["string", "number", "boolean", "null"] }, file: { type: "string" } },
	});
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
	for (const operations of [{}, { files: ["a", "b"] }, { removeFiles: ["a", "b"] }, { files: ["a"], description: "D" }]) {
		assert.throws(() => gist(operations), InvalidRequest);
	}
});

test("validation details name only known fields and static contracts, never received values", () => {
	const cases = [
		[{ kind: "issue-comment", body: "VALUE-SENTINEL" }, /missing: repo, number/],
		[{ kind: "pr-create", repo: target.repo, title: "VALUE-SENTINEL" }, /pr-create needs body or bodyFile/],
		[{ kind: "gist-create", repo: "VALUE-SENTINEL", files: ["a"] }, /unknown field for gist-create: repo/],
		[{ kind: "check", files: ["a"], "sk-KEY-SENTINEL": "VALUE-SENTINEL" }, /unknown fields: 1/],
		[{ kind: "issue-close", ...target, reason: "VALUE-SENTINEL" }, /invalid value: reason; allowed: completed, not-planned/],
		[{ kind: "issue-comment", ...target, body: "VALUE-SENTINEL", bodyFile: "draft.md" }, /body and bodyFile are mutually exclusive/],
	] as const;
	for (const [value, expected] of cases) assert.throws(() => validateRequest(value), error => {
		assert.ok(error instanceof InvalidRequest); assert.match(error.detail ?? "", expected);
		assert.match(error.detail ?? "", new RegExp(`${value.kind} requires: .*optional:`));
		assert.ok(!JSON.stringify(error).includes("SENTINEL")); return true;
	});
	assert.throws(() => validateRequest({ kind: "KIND-SENTINEL" }), error => {
		assert.ok(error instanceof InvalidRequest); assert.match(error.detail ?? "", /^kind must be one of: issue-create, pr-create,/);
		assert.ok(!JSON.stringify(error).includes("SENTINEL")); return true;
	});
});

test("CLI preserves safe validator detail but hides parser exception values", () => {
	assert.throws(() => parseCli(["issue-comment", "--body", "VALUE-SENTINEL"]), error => {
		assert.ok(error instanceof InvalidRequest); assert.match(error.detail ?? "", /missing: repo, number/);
		assert.ok(!JSON.stringify(error).includes("SENTINEL")); return true;
	});
	assert.throws(() => parseCli(["api", "--field-json", "VALUE-SENTINEL"]), error => {
		assert.ok(error instanceof InvalidRequest); assert.equal(error.detail, undefined); return true;
	});
});

test("issue-close maps the typed not-planned reason to gh's spelling", () => {
	const plan = toGhPlan(validateRequest({ kind: "issue-close", ...target, reason: "not-planned" }));
	assert.ok(plan.argv.includes("--reason=not planned"));
	assert.ok(!plan.argv.includes("--reason=not-planned"));
	assert.ok(toGhPlan(validateRequest({ kind: "issue-close", ...target, reason: "completed" })).argv.includes("--reason=completed"));
});

const hosted = { kind: "issue-comment", ...target, body: "Body" } as const;
const longest = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
const acceptedHosts = ["ghe.example.com", "git.corp.example.co", "a1.b-2.example", longest];
const hostileHosts: unknown[] = [
	"https://ghe.example.com", "ghe.example.com/path", "ghe.example.com:8443", "user@ghe.example.com", "ghe.example.com?x", "ghe.example.com#x",
	" ghe.example.com", "ghe.example.com ", "ghe.example.com\n", "\tghe.example.com", "ghe.example.com\0", "ghe\\example.com", "[ghe.example.com]",
	"GHE.Example.com", "ghe.example.COM", "ghe.example.com.", ".ghe.example.com", "localhost", "ghe", "127.0.0.1", "1.2.3.4", "[::1]", "::1",
	"-ghe.example.com", "ghe-.example.com", "ghe.-example.com", "ghe..example.com", "xn--e1afmkfd.example.com", "ghe.xn--p1ai", "ghe.example.xn--p1ai",
	"ghé.example.com", "ghe\uff0eexample.com", "ghe\u200b.example.com", "ghe.example\u202e.com", "ghe.example.com\ufeff", `${longest}d`, `${"a".repeat(64)}.example.com`,
	"--evil", "-", "", "github.com:443", "www.github.com", "api.github.com", "a.b.github.com", 1, 0, true, null, ["ghe.example.com"], { host: "ghe.example.com" },
];

test("runtime host validation accepts only strict lowercase dotted DNS names", () => {
	assert.equal(longest.length, 253);
	for (const host of acceptedHosts) {
		assert.deepEqual(validateRequest({ ...hosted, host }), { ...hosted, host }, host);
	}
	for (const host of hostileHosts) {
		assert.throws(() => validateRequest({ ...hosted, host }), InvalidRequest, JSON.stringify(host));
	}
});

test("runtime permits host only on repository kinds and api; gist, check and HOST/owner/repo syntax stay invalid", () => {
	for (const request of minimalCases) {
		const expected = "repo" in request || request.kind === "api";
		if (expected) assert.equal((validateRequest({ ...request, host: "ghe.example.com" }) as any).host, "ghe.example.com");
		else assert.throws(() => validateRequest({ ...request, host: "ghe.example.com" }), InvalidRequest);
	}
	for (const value of [
		{ kind: "gist-create", files: ["a.md"], host: "ghe.example.com" },
		{ kind: "gist-edit", gistId: "abc123", description: "d", host: "ghe.example.com" },
		{ kind: "check", files: ["a.md"], host: "ghe.example.com" },
		{ ...hosted, repo: "ghe.example.com/owner/repo" },
		{ ...hosted, repo: "ghe.example.com/owner/repo", host: "ghe.example.com" },
	]) assert.throws(() => validateRequest(value), InvalidRequest, JSON.stringify(value));
	assert.throws(() => validateRequest(JSON.parse('{"kind":"issue-comment","repo":"owner/repo","number":39,"body":"B","__proto__":{"host":"ghe.example.com"}}')), InvalidRequest);
	assert.throws(() => validateRequest(Object.assign(Object.create({ host: "ghe.example.com" }), hosted)), InvalidRequest);
	assert.throws(() => validateRequest({ ...hosted, constructor: { host: "ghe.example.com" } }), InvalidRequest);
});

test("host github.com collapses to the default representation without mutating the caller", () => {
	const value = { ...hosted, host: "github.com" };
	const validated = validateRequest(value);
	assert.deepEqual(validated, validateRequest(hosted)); assert.equal("host" in validated, false);
	assert.equal(value.host, "github.com"); assert.ok(Object.isFrozen(validated));
	assert.deepEqual(toGhPlan(value), toGhPlan(hosted));
	assert.deepEqual(toGhPlan({ kind: "api", endpoint: "repos/o/r", method: "POST", host: "github.com" }), toGhPlan({ kind: "api", endpoint: "repos/o/r", method: "POST" }));
});

test("no-host plans keep their exact argv, authority and outbound", () => {
	const plain = toGhPlan(hosted);
	assert.deepEqual(plain.argv, ["issue", "comment", "39", "--repo=owner/repo", { payload: 0, use: "file", prefix: "--body-file=" }]);
	assert.deepEqual(plain.authority, { kind: "issue-comment", ghArgs: ["issue", "comment", "39", "--repo=owner/repo", "--body-file=publication-payload"], repo: "owner/repo", number: 39 });
	assert.deepEqual(plain.outbound, [{ label: "repo", text: "owner/repo" }]);
	assert.equal("host" in plain, false);
	assert.deepEqual(toGhPlan({ kind: "api", endpoint: "repos/o/r", method: "POST" }).argv, ["api", "repos/o/r", "--method=POST", "--hostname=github.com"]);
});

test("host qualifies the gh repo selector, authority key and api hostname, and is scanned outbound", () => {
	const plan = toGhPlan({ ...hosted, host: "ghe.example.com" });
	assert.deepEqual(plan.argv, ["issue", "comment", "39", "--repo=ghe.example.com/owner/repo", { payload: 0, use: "file", prefix: "--body-file=" }]);
	assert.equal(plan.host, "ghe.example.com");
	assert.equal(plan.authority.repo, "ghe.example.com/owner/repo"); assert.equal(plan.authority.host, "ghe.example.com");
	assert.ok(plan.authority.ghArgs.includes("--repo=ghe.example.com/owner/repo"));
	assert.ok(!plan.authority.ghArgs.includes("--repo=owner/repo"));
	assert.ok(plan.outbound.some(source => source.label === "host" && source.text === "ghe.example.com"));
	assert.ok(plan.outbound.some(source => source.label === "repo" && source.text === "ghe.example.com/owner/repo"));
	for (const request of [
		{ kind: "pr-create", repo: "owner/repo", title: "T", body: "B", host: "ghe.example.com" },
		{ kind: "release-notes", repo: "owner/repo", tag: "v1", title: "T", host: "ghe.example.com" },
		{ kind: "pr-merge", ...target, strategy: "squash", host: "ghe.example.com" },
	]) assert.ok(toGhPlan(request as PublishRequest).argv.includes("--repo=ghe.example.com/owner/repo"), request.kind);
	const api = toGhPlan({ kind: "api", endpoint: "repos/o/r/issues", method: "POST", host: "ghe.example.com" });
	assert.deepEqual(api.argv, ["api", "repos/o/r/issues", "--method=POST", "--hostname=ghe.example.com"]);
	assert.equal(api.host, "ghe.example.com"); assert.equal(api.authority.repo, undefined);
	assert.ok(api.outbound.some(source => source.label === "host" && source.text === "ghe.example.com"));
});

test("CLI --host uses the same validator; duplicates, = form and hostile values are invalid", () => {
	assert.deepEqual(parseCli(["issue-comment", "--repo", target.repo, "--host", "ghe.example.com", "--number", "39", "--body", "B"]), { kind: "issue-comment", ...target, host: "ghe.example.com", body: "B" });
	assert.deepEqual(parseCli(["issue-comment", "--repo", target.repo, "--host", "github.com", "--number", "39", "--body", "B"]), { kind: "issue-comment", ...target, body: "B" });
	for (const argv of [
		["issue-comment", "--repo", target.repo, "--host", "ghe.example.com", "--host", "ghe.example.com", "--number", "39", "--body", "B"],
		["issue-comment", "--repo", target.repo, "--host=ghe.example.com", "--number", "39", "--body", "B"],
		["issue-comment", "--repo", target.repo, "--host", "GHE.example.com", "--number", "39", "--body", "B"],
		["issue-comment", "--repo", target.repo, "--host", "https://ghe.example.com", "--number", "39", "--body", "B"],
		["issue-comment", "--repo", target.repo, "--number", "39", "--body", "B", "--host"],
		["check", "--file", "a", "--host", "ghe.example.com"],
	]) assert.throws(() => parseCli(argv), InvalidRequest, argv.join(" "));
});
