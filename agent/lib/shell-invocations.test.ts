import assert from "node:assert/strict";
import { test } from "node:test";
import { shellGuard, shellInvocations } from "./shell-invocations.ts";

for (const [name, field] of [["bash", "command"], ["job_start", "command"], ["job_watch", "check"], ["job_subscribe", "check"]]) {
	test(`${name} uses its executor's actual cwd contract`, () => {
		const input = { [field]: "printf ok", cwd: "child", executionCwd: "/forged", unrelated: "gh issue create" };
		assert.deepEqual(shellInvocations(name, input, "/root").calls, [{ name, input, command: "printf ok", cwd: name === "bash" ? "/root" : "/root/child" }]);
		for (const malformed of [undefined, null, [], {}, { [field]: 7 }, { [field]: " " }]) assert.ok(shellInvocations(name, malformed, "/root").error);
		for (const unsupported of [false, null, {}, "/forged"]) {
			const result = shellInvocations(name, { [field]: "ok", cwd: unsupported }, "/root");
			if (name === "bash") assert.equal(result.calls[0].cwd, "/root");
			else if (typeof unsupported !== "string") assert.ok(result.error);
		}
		assert.equal(shellInvocations(name, { [field]: "ok", cwd: "" }, "/root").calls[0].cwd, "/root");
	});
}

test("wrappers cannot fabricate cwd, malformed children and excess depth fail closed", () => {
	const wrap = (parameters: unknown, recipient_name = "functions.job_subscribe") => ({ tool_uses: [{ recipient_name, parameters }], cwd: "forged" });
	const input = wrap(wrap({ check: "printf ok", cwd: "leaf" }), "multi_tool_use.parallel");
	assert.equal(shellInvocations("multi_tool_use", input, "/root").calls[0].cwd, "/root/leaf");
	for (const malformed of [{}, { tool_uses: {} }, { tool_uses: [null] }, { tool_uses: [{ recipient_name: 7 }] }]) assert.ok(shellInvocations("multi_tool_use", malformed, "/root").error);
	let nested: unknown = { check: "printf ok" }, name = "job_subscribe";
	for (let i = 0; i < 6; i++) { nested = wrap(nested, name); name = "multi_tool_use.parallel"; }
	assert.ok(shellInvocations(name, nested, "/root").error);
});

test("unknown tools are opaque, including object-prototype names", () => {
	for (const name of ["unknown", "toString", "constructor", "publish"]) assert.deepEqual(shellInvocations(name, { command: "gh issue create", cwd: "/forged" }, "/root").calls, [{ name, input: { command: "gh issue create", cwd: "/forged" }, cwd: "/root" }]);
});

test("adapter retains exact session authority, separates target and returns first denial", async () => {
	const sessionManager = {}, seen: unknown[] = [], ctx = { cwd: "/root", sessionManager };
	const handler = shellGuard(async (event, actual, executionCwd) => { assert.equal(actual, ctx); seen.push([event.toolName, actual.cwd, executionCwd, actual.sessionManager]); return event.input.command === "deny" ? { block: true, reason: "existing policy" } : undefined; });
	const input = { tool_uses: [{ recipient_name: "functions.job_watch", parameters: { check: "deny", cwd: "child" } }, { recipient_name: "publish", parameters: {} }] };
	assert.deepEqual(await handler({ toolName: "multi_tool_use.parallel", input }, ctx), { block: true, reason: "existing policy" });
	assert.deepEqual(seen, [["bash", "/root", "/root/child", sessionManager]]);
	assert.equal(await handler({ toolName: "unknown", input: {} }, ctx), undefined);
});
