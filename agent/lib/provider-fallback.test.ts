/** provider-fallback: classification, selection, context veto, turn_end switch/notice. Complements model-drift.test.ts (restore/drift flows). */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fallbackExtension, { DEFAULT_MAX_CONTEXT_TOKENS_FOR_FALLBACK, classifyError, equivalentOf, fallbackContextVeto, selectFallback } from "../extensions/provider-fallback.ts";

const CONFIG = {
	enabled: true,
	limitPatterns: { anthropic: ["rate_limit_error", "usage limit", "\\b429\\b"], openai: ["insufficient_quota"] },
	unavailablePatterns: { anthropic: ["overloaded_error", "\\b50[023]\\b"] },
	pairs: [["anthropic/a", "openai/b"]] as [string, string][],
	chains: { "anthropic/c": ["openai/b", "kimi/k"] } as Record<string, string[]>,
};
const none = () => false;

test("classifyError: limit vs unavailable vs left-to-pi, per provider, case-insensitive, bad regex ignored", () => {
	assert.equal(classifyError(CONFIG, "anthropic", "HTTP 429 Too Many Requests"), "limit");
	assert.equal(classifyError(CONFIG, "anthropic", "You hit your Usage Limit"), "limit");
	assert.equal(classifyError(CONFIG, "anthropic", '{"type":"rate_limit_error"}'), "limit");
	assert.equal(classifyError(CONFIG, "anthropic", "overloaded_error: try later"), "unavailable");
	assert.equal(classifyError(CONFIG, "anthropic", "503 service unavailable"), "unavailable");
	assert.equal(classifyError(CONFIG, "anthropic", "429 and overloaded_error"), "limit"); // limit wins
	assert.equal(classifyError(CONFIG, "anthropic", "invalid_request_error: bad schema"), undefined);
	assert.equal(classifyError(CONFIG, "anthropic", "ECONNRESET"), undefined);
	assert.equal(classifyError(CONFIG, "openai", "429"), undefined); // patterns are per provider
	assert.equal(classifyError(CONFIG, "openai", "insufficient_quota"), "limit");
	assert.equal(classifyError(CONFIG, "unknown", "429"), undefined);
	assert.equal(classifyError({ limitPatterns: { p: ["("] } }, "p", "429"), undefined);
	assert.equal(classifyError({}, "p", "429"), undefined);
});

test("equivalentOf: pairs are bidirectional; unknown has none", () => {
	assert.equal(equivalentOf(CONFIG, "anthropic/a"), "openai/b");
	assert.equal(equivalentOf(CONFIG, "openai/b"), "anthropic/a");
	assert.equal(equivalentOf(CONFIG, "x/y"), undefined);
	assert.equal(equivalentOf({}, "x/y"), undefined);
});

test("selectFallback: pair equivalent; limited candidate is blocked, not chosen", () => {
	assert.deepEqual(selectFallback(CONFIG, "anthropic/a", undefined, none), { target: "openai/b", blocked: [], chain: false });
	assert.deepEqual(selectFallback(CONFIG, "anthropic/a", undefined, p => p === "openai"), { blocked: ["openai/b"], chain: false });
	assert.deepEqual(selectFallback(CONFIG, "x/y", undefined, none), { blocked: [], chain: false }); // no equivalent
});

test("selectFallback: chains take precedence, skip limited providers and the current model, keyed by origin", () => {
	assert.deepEqual(selectFallback(CONFIG, "anthropic/c", undefined, none), { target: "openai/b", blocked: [], chain: true });
	assert.deepEqual(selectFallback(CONFIG, "anthropic/c", undefined, p => p === "openai"), { target: "kimi/k", blocked: ["openai/b"], chain: true });
	assert.deepEqual(selectFallback(CONFIG, "anthropic/c", undefined, () => true), { blocked: ["openai/b", "kimi/k"], chain: true });
	assert.equal(selectFallback(CONFIG, "openai/b", "anthropic/c", none).target, "kimi/k"); // on first hop, next entry; origin selects the chain
	assert.equal(selectFallback(CONFIG, "kimi/k", "anthropic/c", none).target, "openai/b");
});

test("fallbackContextVeto: large main session vetoed; headless, unknown, small, disabled allowed", () => {
	assert.equal(DEFAULT_MAX_CONTEXT_TOKENS_FOR_FALLBACK, 150_000);
	assert.match(fallbackContextVeto({}, true, 200_000) ?? "", /fallback skipped: context 200k > 150k; compact or hand off first/);
	assert.equal(fallbackContextVeto({}, true, 150_000), undefined);
	assert.equal(fallbackContextVeto({}, false, 900_000), undefined);
	assert.equal(fallbackContextVeto({}, true, null), undefined);
	assert.equal(fallbackContextVeto({}, true, undefined), undefined);
	assert.equal(fallbackContextVeto({ maxContextTokensForFallback: 0 }, true, 900_000), undefined);
	assert.match(fallbackContextVeto({ maxContextTokensForFallback: 1000 }, true, 5000) ?? "", /5k > 1k/);
});

// ---- turn_end handler ---------------------------------------------------------------------------

const A = { provider: "anthropic", id: "a" };
const B = { provider: "openai", id: "b" };
let stateFile: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
	saved = { c: process.env.PI_PROVIDER_FALLBACK_CONFIG, s: process.env.PI_PROVIDER_FALLBACK_STATE };
	const dir = mkdtempSync(join(tmpdir(), "pfb-"));
	stateFile = join(dir, "state.json");
	process.env.PI_PROVIDER_FALLBACK_CONFIG = join(dir, "c.json");
	process.env.PI_PROVIDER_FALLBACK_STATE = stateFile;
	writeConfig(CONFIG);
	writeFileSync(stateFile, "{}");
});
afterEach(() => {
	for (const [k, v] of [["PI_PROVIDER_FALLBACK_CONFIG", saved.c], ["PI_PROVIDER_FALLBACK_STATE", saved.s]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
const writeConfig = (c: object) => writeFileSync(process.env.PI_PROVIDER_FALLBACK_CONFIG!, JSON.stringify(c));

function session(opts: { hasUI?: boolean; tokens?: number; model?: typeof A } = {}) {
	let turnEnd: any;
	const notices: [string, string][] = [];
	const switched: any[] = [];
	const ctx: any = {
		hasUI: opts.hasUI ?? false,
		model: opts.model ?? A,
		ui: { notify: (t: string, ty: string) => notices.push([t, ty]) },
		getContextUsage: () => (opts.tokens === undefined ? undefined : { tokens: opts.tokens }),
		modelRegistry: { find: (p: string, id: string) => [A, B].find(m => m.provider === p && m.id === id) },
	};
	const pi: any = {
		on: (name: string, h: any) => { if (name === "turn_end") turnEnd = h; },
		appendEntry: () => {},
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		setModel: async (m: any) => { switched.push(m); ctx.model = m; return true; },
	};
	fallbackExtension(pi);
	const fire = (errorMessage: string | undefined, over: object = {}) => turnEnd({
		message: { role: "assistant", stopReason: "error", errorMessage, provider: "anthropic", model: "a", ...over },
		entries: [{ type: "message", id: "m0" }],
		messageEntryId: "m1",
	}, ctx);
	return { fire, notices, switched, ctx };
}
const marks = () => JSON.parse(readFileSync(stateFile, "utf8"));

test("turn_end limit: marks provider, switches to equivalent, drops failed attempt, records notice", async () => {
	const s = session();
	const r = await s.fire("429 rate_limit_error");
	assert.deepEqual(s.switched, [B]);
	assert.ok(marks().anthropic.until > Date.now() + 59 * 60_000); // default 60 min
	assert.match(s.notices[0][0], /^provider-fallback: anthropic\/a hit a usage\/rate limit \(~\d+ (min|h)\); continuing on openai\/b\.$/);
	assert.equal(s.notices[0][1], "warning");
	assert.deepEqual(r.entries.at(-2), { type: "context_edit", targetId: "m1", replacement: null });
	assert.equal(r.entries.at(-1).customType, "provider-fallback");
	assert.equal(r.entries.at(-1).data.to, "openai/b");
	assert.equal(r.entries.length, 3);
});

test("turn_end: reset time in the error text sets the mark; unavailable uses a short mark and different wording", async () => {
	const s = session();
	await s.fire("usage limit reached, try again in 2 hours");
	const until = marks().anthropic.until;
	assert.ok(until > Date.now() + 119 * 60_000 && until < Date.now() + 121 * 60_000);
	writeFileSync(stateFile, "{}");
	const u = session();
	await u.fire("overloaded_error");
	assert.match(u.notices[0][0], /anthropic\/a is unavailable \(~10 min\); continuing on openai\/b/);
});

test("turn_end: non-limit errors, non-error turns and non-assistant messages are left to pi", async () => {
	const s = session();
	assert.equal(await s.fire("invalid_request_error"), undefined);
	assert.equal(await s.fire(undefined), undefined);
	assert.equal(await s.fire("429", { stopReason: "stop" }), undefined);
	assert.equal(await s.fire("429", { role: "user" }), undefined);
	assert.equal(s.switched.length, 0);
	assert.deepEqual(marks(), {});
});

test("turn_end: disabled config does nothing", async () => {
	writeConfig({ ...CONFIG, enabled: false });
	const s = session();
	assert.equal(await s.fire("429"), undefined);
	assert.equal(s.switched.length, 0);
});

test("turn_end: no equivalent → error notice, no switch", async () => {
	const s = session();
	const r = await s.fire("429", { provider: "anthropic", model: "zzz" });
	assert.equal(s.switched.length, 0);
	assert.match(s.notices[0][0], /anthropic\/zzz hit a usage\/rate limit and has no configured equivalent\./);
	assert.equal(s.notices[0][1], "error");
	assert.equal(r.entries.at(-1).type, "custom_message");
});

test("turn_end: both providers limited → not switching, names both", async () => {
	writeFileSync(stateFile, JSON.stringify({ openai: { until: Date.now() + 3_600_000, since: Date.now() } }));
	const s = session();
	await s.fire("429");
	assert.equal(s.switched.length, 0);
	assert.match(s.notices[0][0], /both providers are limited — anthropic \(.*\) and openai \(.*\)\. Not switching/);
});

test("turn_end: chain with every fallback limited → error notice listing them", async () => {
	writeFileSync(stateFile, JSON.stringify({ openai: { until: Date.now() + 3_600_000, since: 0 }, kimi: { until: Date.now() + 3_600_000, since: 0 } }));
	const s = session({ model: { provider: "anthropic", id: "c" } });
	await s.fire("429", { model: "c" });
	assert.equal(s.switched.length, 0);
	assert.match(s.notices[0][0], /every fallback is limited — openai\/b \(.*\), kimi\/k \(.*\)\. Not switching/);
});

test("turn_end: context veto blocks large main session, allows headless", async () => {
	const main = session({ hasUI: true, tokens: 200_000 });
	await main.fire("429");
	assert.equal(main.switched.length, 0);
	assert.match(main.notices[0][0], /fallback skipped: context 200k > 150k; compact or hand off first\. Not switching\./);
	writeFileSync(stateFile, "{}");
	const small = session({ hasUI: true, tokens: 10_000 });
	await small.fire("429");
	assert.equal(small.switched.length, 1);
	writeFileSync(stateFile, "{}");
	const headless = session({ hasUI: false, tokens: 900_000 });
	await headless.fire("429");
	assert.equal(headless.switched.length, 1);
});

test("turn_end: per-prompt cap (default 2) stops further switches", async () => {
	writeConfig({ ...CONFIG, maxFallbacksPerPrompt: 1 });
	const s = session();
	await s.fire("429");
	assert.equal(s.switched.length, 1);
	writeFileSync(stateFile, "{}"); // pretend marks cleared so only the cap stops us
	const second = await s.fire("429", { provider: "openai", model: "b" });
	assert.equal(second, undefined); // openai has no limit pattern for "429"
	const third = await s.fire("insufficient_quota", { provider: "openai", model: "b" });
	assert.equal(s.switched.length, 1);
	assert.match(s.notices.at(-1)![0], /per-prompt fallback cap was reached\. Not switching\./);
	assert.equal(third.entries.at(-1).type, "custom_message");
});
