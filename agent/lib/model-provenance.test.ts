import { strict as assert } from "node:assert";
import { test } from "node:test";
import register from "../extensions/model-provenance.ts";
import { buildProvenance, PROVENANCE_SOURCE } from "./model-provenance.ts";

const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
const at = "2026-10-27T02:43:49.356Z";
const assistant = (modelRef = OPUS, stopReason = "stop", timestamp = at) => {
	const [provider, model] = modelRef.split("/");
	return { type: "message", timestamp, message: { role: "assistant", provider, model, stopReason,
		content: [{ type: "text", text: "SENTINEL-NOT-PROVENANCE" }], errorMessage: "SENTINEL-ERROR" } };
};
const change = (modelRef: string) => {
	const [provider, modelId] = modelRef.split("/");
	return { type: "model_change", provider, modelId, timestamp: at };
};
const reason = (to: string, text: string) => ({ type: "custom", customType: "provider-fallback", data: { text, from: OPUS, to, until: 123 } });
const named = { type: "session_info", name: "reviewer#90ac171a" };

test("correct provenance has model, identity and assistant timestamps, not content", () => {
	const last = "2026-10-27T02:45:00.000Z";
	const result = buildProvenance([null, 12, {}, change(OPUS), named, assistant(), assistant(), assistant(OPUS, "stop", last)], { session: "session" });
	assert.deepEqual(result.models, [OPUS]);
	assert.deepEqual(result.switches, []);
	assert.equal(result.initial, OPUS);
	assert.equal(result.assistants, 3);
	assert.deepEqual(result.modelCounts, { [OPUS]: 3 });
	assert.equal(result.errors, 0);
	assert.equal(result.session, "session");
	assert.equal(result.agent, named.name);
	assert.equal(result.firstAt, at);
	assert.equal(result.lastAt, last);
	assert.equal(result.source, PROVENANCE_SOURCE);
	assert.doesNotMatch(JSON.stringify(result), /SENTINEL|content|errorMessage/);
});

test("initial fallback uses effective assistant records, not the initial model", () => {
	const result = buildProvenance([change(OPUS), named, change(SOL), reason(SOL, "limited"), assistant(SOL)]);
	assert.equal(result.initial, OPUS);
	assert.deepEqual(result.models, [SOL]);
	assert.deepEqual(result.switches, [{ at, from: OPUS, to: SOL, when: "before-first-response", reason: "limited" }]);
});

test("mid-review fallback after a request failure includes error model and clipped reason", () => {
	const result = buildProvenance([change(OPUS), assistant(), assistant(OPUS, "error"), reason(SOL, "x".repeat(1000)), change(SOL), assistant(SOL)]);
	assert.deepEqual(result.models, [OPUS, SOL]);
	assert.deepEqual(result.modelCounts, { [OPUS]: 2, [SOL]: 1 });
	assert.equal(result.errors, 1);
	assert.deepEqual(result.switches, [{ at, from: OPUS, to: SOL, when: "after-request-failure", reason: "x".repeat(160) }]);
});

test("request failure or duplicate model selections without a switch do not invalidate attribution", () => {
	const result = buildProvenance([change(OPUS), assistant(OPUS, "error"), change(OPUS), assistant()]);
	assert.deepEqual(result.models, [OPUS]);
	assert.equal(result.errors, 1);
	assert.deepEqual(result.switches, []);
});

test("switch during review is classified and reasons must match destination and change window", () => {
	const result = buildProvenance([change(OPUS), assistant(), change(SOL), reason(OPUS, "wrong destination"), change(OPUS)]);
	assert.equal(result.switches[0].when, "mid-review");
	assert.equal(result.switches[0].reason, undefined);
	assert.equal(result.switches[1].reason, "wrong destination");
});

test("historical switches alone do not invent assistant model records; missing models are unavailable", () => {
	assert.deepEqual(buildProvenance([change(OPUS), change(SOL)]).models, []);
	assert.deepEqual(buildProvenance([change(SOL), change(OPUS), assistant()]).models, [OPUS]);
	assert.equal(buildProvenance([{ type: "message", message: { role: "assistant" } }]).unavailable, "assistant model record missing");
});

function hook() {
	const handlers = new Map<string, Function>();
	register({ on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
	return handlers.get("tool_call")!;
}

test("headless hook overwrites forged attribution in place, leaving findings untouched", () => {
	const run = hook();
	const input = { summary: "x", findings: [], runtimeProvenance: { forged: true } };
	const entries = [change(OPUS), named, assistant()];
	const ctx = { hasUI: false, sessionManager: { getBranch: () => entries, getSessionId: () => "s" } };
	assert.equal(run({ toolName: "StructuredOutput", input }, ctx), undefined);
	assert.deepEqual(input.runtimeProvenance, { ...buildProvenance(entries, { session: "s" }), runtimeStamp: "model-provenance/tool-call/v1" });
	assert.equal(input.summary, "x");
	assert.deepEqual(input.findings, []);
	const other = { runtimeProvenance: "untouched" };
	run({ toolName: "bash", input: other }, ctx);
	assert.equal(other.runtimeProvenance, "untouched");
	for (const value of [null, undefined, [], "text", new Date()]) {
		assert.equal(run({ toolName: "StructuredOutput", input: value }, ctx), undefined);
	}
});

test("branch exceptions replace forged attribution with a value-free unavailable marker, never block", () => {
	const input = { runtimeProvenance: { models: [OPUS] } };
	const result = hook()({ toolName: "StructuredOutput", input }, { sessionManager: { getBranch: () => { throw new Error("SENTINEL"); } } });
	assert.equal(result, undefined);
	assert.deepEqual(input.runtimeProvenance, { source: PROVENANCE_SOURCE, runtimeStamp: "model-provenance/tool-call/v1", models: [], unavailable: "runtime session records unavailable" });
});
