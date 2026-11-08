import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import publishExtension, { cliMain, PUBLISH_HELP } from "../extensions/publish.ts";
import type { PublishServices } from "../extensions/publish.ts";
import { publish } from "./publisher.ts";
import type { PublishCode, PublishResult } from "./publisher.ts";
import { setGuards } from "./guards.ts";

const request = { kind: "issue-comment", repo: "owner/repo", number: 39, bodyFile: "private-value.md" };
const context: any = { cwd: "/synthetic/repo", sessionManager: { getSessionId: () => "real-session" } };
function outcome(code: PublishCode = "published"): PublishResult {
	return { code, text: code === "published" ? "published" : code === "scan-clean" ? "scan clean" : `publish: ${code}`, isError: !["published", "scan-clean"].includes(code) };
}
function tool(services: PublishServices) {
	let registered: any;
	publishExtension({ registerTool: (definition: unknown) => { registered = definition; } } as any, services);
	return registered;
}
const allowed: PublishServices = { admit: () => undefined, candidate: async () => ({}), root: () => "/synthetic/repo", send: async () => outcome() };

test("registered typed tool performs both admissions before any payload work with immutable exact request/context", async () => {
	const steps: string[] = [], controller = new AbortController();
	const registered = tool({ ...allowed,
		admit: (value, actor) => { steps.push("lane"); assert.ok(Object.isFrozen(value)); assert.deepEqual(actor, { cwd: context.cwd, session: "real-session" }); },
		candidate: async () => { steps.push("candidate"); return {}; },
		send: async (value, ctx) => { steps.push("send"); assert.deepEqual(value, request); assert.equal(ctx?.signal, controller.signal); assert.equal(ctx?.repoRoot, context.cwd); return outcome(); },
	});
	assert.equal(registered.name, "publish"); assert.equal(registered.parameters.additionalProperties, false);
	const result = await registered.execute("id", request, controller.signal, undefined, context);
	assert.deepEqual(steps, ["lane", "candidate", "send"]);
	assert.deepEqual(result.details, { code: "published" }); assert.equal(result.isError, false);
	assert.equal(result.content[0].text, "published"); assert.ok(!JSON.stringify(result).includes("private-value"));
});

for (const blocked of ["lane", "candidate", "exception"] as const) test(`execute ${blocked} admission refusal is value-free and cannot reach payload IO`, async () => {
	let sends = 0;
	const registered = tool({ ...allowed, admit: () => { if (blocked === "exception") throw new Error("private-value"); return blocked === "lane" ? "private-value" : undefined; },
		candidate: async () => ({ block: "private-value" }), root: () => { assert.fail("no payload context before admission"); },
		send: async () => { sends++; return outcome(); },
	});
	const result = await registered.execute("id", request, undefined, undefined, context);
	assert.equal(result.isError, true); assert.equal(sends, 0); assert.ok(!JSON.stringify(result).includes("private-value"));
});

test("invalid raw selector/override parameters fail before authority checks or publisher", async () => {
	const registered = tool({ admit: () => { assert.fail("must validate first"); }, send: async () => { assert.fail("must not send"); } });
	for (const input of [{ ...request, args: ["private-value"] }, { ...request, env: {} }, { ...request, skipScan: true }, { kind: "help" }]) {
		const result = await registered.execute("id", input, undefined, undefined, context);
		assert.equal(result.details.code, "invalid-request"); assert.ok(!JSON.stringify(result).includes("private-value"));
	}
});

test("publish switch off does not disable scanner or execute admission", async () => {
	let admissions = 0;
	setGuards("publish", true);
	try {
		const registered = tool({ ...allowed, admit: () => { admissions++; }, send: (value, ctx) => publish(value, ctx, { io: { mkdtemp: async () => { assert.fail("scan first"); } } }) });
		const result = await registered.execute("id", { ...request, bodyFile: undefined, body: "[REDACTED:example]" }, undefined, undefined, context);
		assert.equal(result.details.code, "invalid-request"); // explicit undefined file is still an invalid xor field
		const valid = await registered.execute("id", { kind: "issue-comment", repo: "owner/repo", number: 39, body: "[REDACTED:example]" }, undefined, undefined, context);
		assert.equal(valid.details.code, "scan-refused"); assert.equal(admissions, 1);
		assert.ok(!JSON.stringify(valid).includes("[REDACTED:"));
	} finally { setGuards("publish", false); }
});

test("check has typed admission and no later publication guarantee; warnings/errors never echo candidate data", async () => {
	const registered = tool({ ...allowed, candidate: async () => ({ warn: "private-value", log: "private-value" }), send: async () => outcome("scan-clean") });
	const result = await registered.execute("id", { kind: "check", files: ["draft"] }, undefined, undefined, context);
	assert.equal(result.details.code, "scan-clean"); assert.ok(!JSON.stringify(result).includes("private-value"));
	const failed = tool({ ...allowed, send: async () => { throw new Error("private-value"); } });
	assert.equal((await failed.execute("id", request, undefined, undefined, context)).details.code, "adapter-failed");
});

test("CLI help is standalone and parsed requests use only shared publisher core", async () => {
	let calls = 0;
	const send: NonNullable<PublishServices["send"]> = async value => { calls++; assert.deepEqual(value, request); return outcome(); };
	assert.deepEqual(await cliMain(["--help"], { send }), { text: PUBLISH_HELP, exitCode: 0 }); assert.equal(calls, 0);
	assert.deepEqual(await cliMain(["issue-comment", "--repo", "owner/repo", "--number", "39", "--body-file", "private-value.md"], { send }), { text: "published", exitCode: 0 });
	assert.equal(calls, 1);
	assert.equal((await cliMain(["--help", "issue-create"], { send })).exitCode, 2);
	assert.equal((await cliMain(["check", "--file", "a", "--method", "POST"], { send })).exitCode, 2);
});
for (const [code, expected] of [["invalid-request", 2], ["scan-refused", 3], ["payload-unreadable", 4], ["cleanup-failed", 4], ["gh-failed", 5], ["gh-timeout", 5], ["host-unauthenticated", 5], ["cancelled", 130]] as const) test(`CLI fixed exit for ${code}`, async () => {
	const result = await cliMain(["check", "--file", "a"], { send: async () => outcome(code) });
	assert.deepEqual(result, { text: `publish: ${code}`, exitCode: expected });
});
test("bin help smoke does not publish or show raw paths", () => {
	const text = execFileSync(process.execPath, [new URL("../bin/pi-publish", import.meta.url).pathname, "--help"], { encoding: "utf8" });
	assert.equal(text, PUBLISH_HELP);
});

test("hosted request: schema offers host, both admissions see it intact, denial still blocks, hostile host fails before admission", async () => {
	const hosted = { ...request, host: "ghe.example.com" }, seen: unknown[] = [];
	const registered = tool({ ...allowed,
		admit: value => { seen.push(value); }, candidate: async value => { seen.push(value); return {}; },
		send: async value => { seen.push(value); return outcome(); },
	});
	assert.ok(registered.parameters.properties.host);
	assert.match(registered.description, /host/); assert.match(registered.description, /gh auth login --hostname/);
	assert.equal((await registered.execute("id", hosted, undefined, undefined, context)).details.code, "published");
	assert.equal(seen.length, 3); for (const value of seen) assert.deepEqual(value, hosted);
	let sends = 0;
	const denied = tool({ ...allowed, admit: () => "private-value", send: async () => { sends++; return outcome(); } });
	assert.equal((await denied.execute("id", hosted, undefined, undefined, context)).details.code, "admission-denied"); assert.equal(sends, 0);
	const strict = tool({ admit: () => { assert.fail("must validate first"); }, send: async () => { assert.fail("must not send"); } });
	for (const host of ["https://ghe.example.com", "GHE.example.com", "ghe.example.com:8443", "127.0.0.1", "ghe"])
		assert.equal((await strict.execute("id", { ...request, host }, undefined, undefined, context)).details.code, "invalid-request", host);
});

test("CLI --host reaches the publisher with the host; help documents it", async () => {
	let seen: unknown;
	const result = await cliMain(["issue-comment", "--repo", "owner/repo", "--host", "ghe.example.com", "--number", "39", "--body-file", "private-value.md"], { send: async value => { seen = value; return outcome("host-unauthenticated"); } });
	assert.deepEqual(seen, { ...request, host: "ghe.example.com" });
	assert.deepEqual(result, { text: "publish: host-unauthenticated", exitCode: 5 });
	assert.equal((await cliMain(["issue-comment", "--repo", "owner/repo", "--host", "https://ghe.example.com", "--number", "39", "--body", "B"], { send: async () => assert.fail("must not send") })).exitCode, 2);
	assert.match(PUBLISH_HELP, /--host HOST/); assert.match(PUBLISH_HELP, /gh auth login --hostname HOST/);
});
