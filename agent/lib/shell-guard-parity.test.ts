import assert from "node:assert/strict";
import { test } from "node:test";
import killGuard from "../extensions/kill-guard.ts";
import priorityGuard from "../extensions/phase-priority.ts";
import cratisGuard, { cratisRunner, setCratisRunner } from "../extensions/cratis-cli-guard.ts";
import { cratisRepo, inCwd, loaded } from "./cratis-hooks-detect.test.ts";
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

function callback(factory: any, getAllTools: any = () => []) {
	let handler: any;
	factory({ on: (name: string, fn: any) => { if (name === "tool_call") handler = fn; }, registerCommand() {}, getAllTools });
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

function coveredEnvelopes(command: string) {
	const direct = envelopes(command);
	const nested = { tool_uses: [{ recipient_name: "functions.bash", parameters: { command } }] };
	return [...direct, ...direct.map(event => ({ ...event, toolName: `functions.${event.toolName}` })),
		{ toolName: "multi_tool_use", input: nested },
		{ toolName: "multi_tool_use.parallel", input: nested },
		{ toolName: "functions.multi_tool_use.parallel", input: { tool_uses: [{ recipient_name: "multi_tool_use", parameters: nested }] } }];
}

test("loaded Cratis hooks retain execution-envelope coverage", async () => {
	const repo = cratisRepo();
	const previousRunner = cratisRunner;
	try {
		await inCwd(repo.root, async () => {
			let status = 2, probes = 0;
			const runner = () => { probes++; return { status }; };
			setCratisRunner(runner);
			const mutation = callback(cratisGuard, loaded(repo));
			const secrets = createHandlers({ config: () => ({ ...DEFAULTS }), role: () => "main", guardOff: () => false,
				cratisRunner: runner, tools: loaded(repo), orchestrated: () => true, decision() {}, error() {} });
			for (const [handler, command] of [[mutation, "cratis chronicle replay"], [secrets.toolCall, "printenv"]] as const) {
				for (const event of coveredEnvelopes(command)) {
					let executions = 0;
					const verdict = await handler(event, { ...context, cwd: repo.root });
					if (!verdict?.block) executions++;
					assert.equal(executions, event.toolName === "bash" ? 1 : 0, event.toolName);
				}
				status = 0;
				for (const event of coveredEnvelopes(command)) assert.equal((await handler(event, { ...context, cwd: repo.root }))?.block, true, event.toolName);
				status = 2;
				for (const event of coveredEnvelopes("printf ok")) assert.equal(await handler(event, context), undefined);
			}
			assert.ok(probes > 0);
		});
	} finally { setCratisRunner(previousRunner); repo.cleanup(); }
});

test("Cratis permission switch retains credential-read permission in every envelope", async () => {
	const handlers = createHandlers({ config: () => ({ ...DEFAULTS }), role: () => "main", guardOff: () => false,
		cratisSecrets: () => "switch", decision() {}, error() {} });
	for (const event of coveredEnvelopes("printenv")) assert.equal(await handlers.toolCall(event, context as any), undefined);
});

test("all execution envelopes enforce dangerous-kill denial", async () => {
	let handler: any;
	killGuard({ on: (_name: string, fn: any) => { handler = fn; } } as any);
	for (const event of envelopes("pkill -f dotnet")) assert.equal((await handler(event, { cwd: "/tmp" }))?.block, true, event.toolName);
	for (const event of envelopes("printf ok")) assert.equal(await handler(event, { cwd: "/tmp" }), undefined);
});
