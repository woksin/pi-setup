import assert from "node:assert/strict";
import { test } from "node:test";
import killGuard from "../extensions/kill-guard.ts";
import priorityGuard from "../extensions/phase-priority.ts";
import cratisGuard from "../extensions/cratis-cli-guard.ts";
import resultGuard from "../extensions/subagent-result-guard.ts";
import { createHandlers, DEFAULTS } from "./secret-mask.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicationInput } from "./publish-guard.ts";

const envelopes = (command: string) => [
	{ toolName: "bash", input: { command } },
	{ toolName: "job_start", input: { command } },
	{ toolName: "job_watch", input: { check: command } },
	{ toolName: "job_subscribe", input: { check: command } },
];

test("all execution envelopes retain publication denial and legitimate read checks", () => {
	for (const event of envelopes("gh issue create")) assert.equal(publicationInput(event.toolName, event.input), "gh-publication", event.toolName);
	for (const event of envelopes("gh issue list")) assert.equal(publicationInput(event.toolName, event.input), undefined);
});

function callback(factory: any) {
	let handler: any;
	factory({ on: (name: string, fn: any) => { if (name === "tool_call") handler = fn; }, registerCommand() {}, getAllTools: () => [] });
	return handler;
}
const context = { cwd: "/tmp", hasUI: false, sessionManager: { getSessionId: () => "parity-test" }, ui: { notify() {} } };

for (const [name, factory, command] of [
	["priority grants", priorityGuard, "pi-phase grant-priority --uses 1"],
	["production mutations", cratisGuard, "cratis chronicle replay --context production"],
	["protected transcript reads", resultGuard, `cat ${join(tmpdir(), "pi-subagents-test", "cwd", "session", "tasks", "task.output")}`],
] as const) test(`${name} deny all execution envelopes, allow ordinary checks`, async () => {
	const handler = callback(factory);
	for (const event of envelopes(command)) assert.equal((await handler(event, context))?.block, true, event.toolName);
	for (const event of envelopes("printf ok")) assert.equal(await handler(event, context), undefined, event.toolName);
});

test("credential reads deny every envelope and operator-off preserves permission", async () => {
	let off = false;
	const handlers = createHandlers({ config: () => ({ ...DEFAULTS }), role: () => "main", guardOff: () => off,
		orchestrated: () => true, cratisSecrets: () => false, decision() {}, error() {} });
	for (const event of envelopes("printenv")) assert.equal((await handlers.toolCall(event, context as any))?.block, true, event.toolName);
	for (const event of envelopes("printf ok")) assert.equal(await handlers.toolCall(event, context as any), undefined);
	off = true;
	for (const event of envelopes("printenv")) assert.equal(await handlers.toolCall(event, context as any), undefined);
});

test("all execution envelopes enforce dangerous-kill denial", async () => {
	let handler: any;
	killGuard({ on: (_name: string, fn: any) => { handler = fn; } } as any);
	for (const event of envelopes("pkill -f dotnet")) assert.equal((await handler(event, { cwd: "/tmp" }))?.block, true, event.toolName);
	for (const event of envelopes("printf ok")) assert.equal(await handler(event, { cwd: "/tmp" }), undefined);
});
