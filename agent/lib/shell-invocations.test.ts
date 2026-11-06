import assert from "node:assert/strict";
import { test } from "node:test";
import { shellGuard, shellInvocations } from "./shell-invocations.ts";

for (const [name, field] of [["bash", "command"], ["job_start", "command"], ["job_watch", "check"], ["job_subscribe", "check"]]) {
	test(`${name} has one explicit command field and resolves cwd`, () => {
		assert.deepEqual(shellInvocations(name, { [field]: "printf ok", cwd: "child", unrelated: "gh issue create" }, "/root").calls,
			[{ name, input: { [field]: "printf ok", cwd: "child", unrelated: "gh issue create" }, command: "printf ok", cwd: "/root/child" }]);
		for (const input of [undefined, null, [], {}, { [field]: 7 }, { [field]: " " }, { [field]: "ok", cwd: false }]) assert.ok(shellInvocations(name, input, "/root").error);
	});
}

test("known nested wrappers inherit cwd, reject malformed children and bound depth", () => {
	const wrap = (parameters: unknown, recipient_name = "functions.job_subscribe") => ({ tool_uses: [{ recipient_name, parameters }], cwd: "child" });
	const input = wrap(wrap({ check: "printf ok", cwd: "leaf" }), "multi_tool_use.parallel");
	assert.equal(shellInvocations("multi_tool_use", input, "/root").calls[0].cwd, "/root/child/child/leaf");
	for (const malformed of [{}, { tool_uses: {} }, { tool_uses: [null] }, { tool_uses: [{ recipient_name: 7 }] }]) assert.ok(shellInvocations("multi_tool_use", malformed, "/root").error);
	let nested: unknown = { check: "printf ok" }, name = "job_subscribe";
	for (let i = 0; i < 6; i++) { nested = wrap(nested, name); name = "multi_tool_use.parallel"; }
	assert.ok(shellInvocations(name, nested, "/root").error);
});

test("unknown tools are opaque, including object-prototype names", () => {
	for (const name of ["unknown", "toString", "constructor", "publish"]) assert.deepEqual(shellInvocations(name, { command: "gh issue create" }, "/root").calls, [{ name, input: { command: "gh issue create" }, cwd: "/root" }]);
});

test("adapter preserves context identity, typed leaves and first blocking result", async () => {
	const sessionManager = {}, seen: unknown[] = [];
	const handler = shellGuard(async (event, ctx) => { seen.push([event.toolName, ctx.cwd, ctx.sessionManager]); return event.input.command === "deny" ? { block: true, reason: "existing policy" } : undefined; });
	const input = { tool_uses: [{ recipient_name: "functions.job_watch", parameters: { check: "deny", cwd: "child" } }, { recipient_name: "publish", parameters: {} }] };
	assert.deepEqual(await handler({ toolName: "multi_tool_use.parallel", input }, { cwd: "/root", sessionManager }), { block: true, reason: "existing policy" });
	assert.deepEqual(seen, [["bash", "/root/child", sessionManager]]);
	assert.equal(await handler({ toolName: "unknown", input: {} }, { cwd: "/root", sessionManager }), undefined);
});
