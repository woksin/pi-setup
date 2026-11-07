import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../extensions/subagent-cache.ts";
import { processRoles } from "./output-cap.ts";
import { isShortTierRole, stripLongTtl } from "./subagent-cache.ts";

const cache = () => ({ type: "ephemeral", ttl: "1h" });
const fixture = () => ({
	system: [{ type: "text", text: "system", cache_control: cache() }],
	messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: cache() }] }],
	tools: [{ name: "read", cache_control: cache() }],
});

test("strips long cache TTLs from Anthropic and Bedrock without mutating input", () => {
	const payload = { ...fixture(), toolConfig: { tools: [{ cachePoint: { type: "default", ttl: "1h" } }] } };
	const before = structuredClone(payload);
	const result = stripLongTtl(payload) as any;
	assert.deepEqual(payload, before);
	assert.equal(result.system[0].cache_control.ttl, undefined);
	assert.equal(result.messages[0].content[0].cache_control.ttl, undefined);
	assert.equal(result.tools[0].cache_control.ttl, undefined);
	assert.deepEqual(result.toolConfig.tools[0].cachePoint, { type: "default" });
	const bedrock = { system: [{ cachePoint: { type: "default", ttl: "1h" } }], messages: [{ content: [{ cachePoint: { type: "default", ttl: "1h" } }] }] };
	assert.deepEqual(stripLongTtl(bedrock), { system: [{ cachePoint: { type: "default" } }], messages: [{ content: [{ cachePoint: { type: "default" } }] }] });
});

test("unrelated TTLs, short cache fields and OpenAI payloads are untouched", () => {
	for (const payload of [null, "text", { messages: [{ role: "user", content: "hello" }] },
		{ system: [{ ttl: "1h", cache_control: { ttl: "5m" }, cachePoint: { ttl: "other" } }] },
		{ metadata: { cache_control: cache() } }]) assert.equal(stripLongTtl(payload), undefined);
	const payload = { ...fixture(), metadata: { ttl: "1h" }, tools: [{ cache_control: { ttl: "5m" } }] };
	const result = stripLongTtl(payload) as any;
	assert.equal(result.metadata, payload.metadata);
	assert.equal(result.tools, payload.tools);
});

test("tool arguments and tool schemas are never rewritten", () => {
	const nested = () => ({ cache_control: { type: "ephemeral", ttl: "1h" }, cachePoint: { type: "default", ttl: "1h" } });
	const payload = {
		messages: [{ role: "assistant", content: [
			{ type: "tool_use", id: "t1", name: "write", input: nested() },
			{ toolUse: { toolUseId: "t2", name: "write", input: nested() } },
		] }],
		tools: [{ name: "write", input_schema: nested() }, { toolSpec: { name: "write", inputSchema: { json: nested() } } }],
	};
	assert.equal(stripLongTtl(payload), undefined);
	const mixed = { ...payload, system: [{ type: "text", text: "s", cache_control: cache() }] };
	const result = stripLongTtl(mixed) as any;
	assert.equal(result.system[0].cache_control.ttl, undefined);
	assert.equal(result.messages, mixed.messages);
	assert.equal(result.tools, mixed.tools);
});

test("only known subagents use the short tier; kill switch and shared env stay safe", () => {
	const roles = processRoles();
	const primary = roles.primary;
	const previous = process.env.PI_SUBAGENT_CACHE;
	const retention = process.env.PI_CACHE_RETENTION;
	const handlers: Record<string, any> = {};
	extension({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);
	const ctx = (id?: string) => ({ sessionManager: { getSessionId: () => id } });
	const event = { payload: fixture() };
	try {
		delete process.env.PI_SUBAGENT_CACHE;
		roles.primary = undefined;
		assert.equal(handlers.before_provider_request(event, ctx()), undefined);
		handlers.session_start({ reason: "startup" }, ctx("main"));
		assert.equal(handlers.before_provider_request(event, ctx("main")), undefined);
		handlers.session_start({ reason: "startup" }, ctx("child"));
		assert.ok(handlers.before_provider_request(event, ctx("child")));
		process.env.PI_SUBAGENT_CACHE = "long";
		assert.equal(handlers.before_provider_request(event, ctx("child")), undefined);
		assert.equal(process.env.PI_CACHE_RETENTION, retention);
		assert.equal(isShortTierRole("subagent"), true);
		assert.equal(isShortTierRole("main"), false);
		assert.equal(isShortTierRole("unknown"), false);
	} finally {
		roles.primary = primary;
		if (previous === undefined) delete process.env.PI_SUBAGENT_CACHE;
		else process.env.PI_SUBAGENT_CACHE = previous;
	}
});
