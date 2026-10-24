/** provider-fallback: classification, selection, context veto, turn_end switch/notice. Complements model-drift.test.ts (restore/drift flows). */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fallbackExtension, { DEFAULT_MAX_CONTEXT_TOKENS_FOR_FALLBACK, fallbackContextLimit, classifyError, equivalentOf, fallbackContextVeto, selectFallback } from "../extensions/provider-fallback.ts";

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

test("auto uses target registry window minus output, capped by main/subagent handoff budget", () => {
	const big = { provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 1_050_000, maxTokens: 128_000 };
	const small = { ...big, id: "small", contextWindow: 272_000 };
	assert.equal(DEFAULT_MAX_CONTEXT_TOKENS_FOR_FALLBACK, "auto");
	assert.equal(fallbackContextLimit({}, true, big), 400_000);
	assert.equal(fallbackContextLimit({}, false, big), 200_000);
	assert.equal(fallbackContextLimit({}, true, small), 72_000);
	assert.equal(fallbackContextLimit({ fallbackContextRatio: 0.25 }, true, small), 36_000);
	assert.equal(fallbackContextLimit({ maxContextTokensForFallback: 150_000 }, false, small), 150_000);
	assert.equal(fallbackContextVeto({}, true, 400_000, { target: big }), undefined);
	assert.match(fallbackContextVeto({}, true, 450_000, { target: big }) ?? "", /auto: 400k for openai-codex\/gpt-6.1-sol/);
	assert.match(fallbackContextVeto({}, false, 250_000, { target: big }) ?? "", /auto: 200k/);
	assert.match(fallbackContextVeto({}, true, 80_000, { target: small }) ?? "", /auto: 72k.*context_handoff now.*next prompt/);
	assert.equal(fallbackContextVeto({}, true, null), undefined);
	assert.equal(fallbackContextVeto({}, true, undefined), undefined);
	assert.equal(fallbackContextVeto({ maxContextTokensForFallback: 0 }, true, 900_000), undefined);
	assert.match(fallbackContextVeto({ maxContextTokensForFallback: 1000 }, true, 5000) ?? "", /5k > override: 1k/);
});

// ---- turn_end handler ---------------------------------------------------------------------------

const A = { provider: "anthropic", id: "a" };
const B = { provider: "openai", id: "b" };
let stateFile: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
	saved = { c: process.env.PI_PROVIDER_FALLBACK_CONFIG, s: process.env.PI_PROVIDER_FALLBACK_STATE, b: process.env.PI_CONTEXT_BUDGET_CONFIG, bd: process.env.PI_CONTEXT_BUDGET_STATE_DIR };
	const dir = mkdtempSync(join(tmpdir(), "pfb-"));
	stateFile = join(dir, "state.json");
	process.env.PI_PROVIDER_FALLBACK_CONFIG = join(dir, "c.json");
	process.env.PI_PROVIDER_FALLBACK_STATE = stateFile;
	process.env.PI_CONTEXT_BUDGET_CONFIG = join(dir, "budget.json");
	process.env.PI_CONTEXT_BUDGET_STATE_DIR = dir;
	writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG, "{}");
	writeConfig(CONFIG);
	writeFileSync(stateFile, "{}");
});
afterEach(() => {
	for (const [k, v] of [["PI_PROVIDER_FALLBACK_CONFIG", saved.c], ["PI_PROVIDER_FALLBACK_STATE", saved.s], ["PI_CONTEXT_BUDGET_CONFIG", saved.b], ["PI_CONTEXT_BUDGET_STATE_DIR", saved.bd]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
const writeConfig = (c: object) => writeFileSync(process.env.PI_PROVIDER_FALLBACK_CONFIG!, JSON.stringify(c));

function session(opts: { hasUI?: boolean; tokens?: number; model?: typeof A; target?: { contextWindow: number; maxTokens: number } } = {}) {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const notices: [string, string][] = [];
	const switched: any[] = [];
	const ctx: any = {
		hasUI: opts.hasUI ?? false,
		model: opts.model ?? A,
		ui: { notify: (t: string, ty: string) => notices.push([t, ty]) },
		getContextUsage: () => (opts.tokens === undefined ? undefined : { tokens: opts.tokens }),
		modelRegistry: { find: (p: string, id: string) => [A, opts.target ? { ...B, ...opts.target } : B].find(m => m.provider === p && m.id === id) },
	};
	const pi: any = {
		on: (name: string, h: any) => { handlers[name] = h; },
		registerCommand: (name: string, command: any) => { commands[name] = command; },
		appendEntry: () => {},
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		setModel: async (m: any) => { switched.push(m); ctx.model = m; return true; },
	};
	fallbackExtension(pi);
	const fire = (errorMessage: string | undefined, over: object = {}) => handlers.turn_end({
		message: { role: "assistant", stopReason: "error", errorMessage, provider: "anthropic", model: "a", ...over },
		entries: [{ type: "message", id: "m0" }],
		messageEntryId: "m1",
	}, ctx);
	return { fire, notices, switched, ctx,
		restore: (args = "") => commands["provider-restore"].handler(args, ctx),
		boundary: (name = "turn_start") => handlers[name]({}, ctx),
	};
}
const marks = () => JSON.parse(readFileSync(stateFile, "utf8"));

test("provider-restore clears only the named mark and immediately restores despite disabled expiry restore", async () => {
	writeConfig({ ...CONFIG, restoreWhenExpired: false });
	const s = session();
	await s.fire("429");
	writeFileSync(stateFile, JSON.stringify({ ...marks(), kimi: { until: Date.now() + 60_000, since: 0 } }));
	await s.restore("anthropic");
	assert.deepEqual(Object.keys(marks()), ["kimi"]);
	assert.deepEqual(s.switched, [B, A]);
	assert.match(s.notices.at(-2)![0], /restore requested/);
	await s.restore();
	assert.deepEqual(marks(), {});
});

test("broadcast is consumed by another session at either boundary, once, but not a fallback-original session", async () => {
	writeConfig({ ...CONFIG, restoreWhenExpired: false });
	const sender = session();
	const receiver = session();
	const nativeFallback = session({ model: B });
	await sender.fire("429");
	await receiver.boundary("before_agent_start");
	assert.deepEqual(receiver.switched, [B]);
	await sender.restore("--all");
	await receiver.boundary();
	await receiver.boundary();
	await nativeFallback.boundary();
	assert.deepEqual(receiver.switched, [B, A]);
	assert.deepEqual(nativeFallback.switched, []);
	const first = JSON.parse(readFileSync(join(join(stateFile, ".."), ".provider-restore.json"), "utf8"))["*"];
	await sender.restore("--all");
	const second = JSON.parse(readFileSync(join(join(stateFile, ".."), ".provider-restore.json"), "utf8"))["*"];
	assert.ok(second > first);
});

test("broadcast cannot override a fresh real limit and restored providers still fall back on failure", async () => {
	writeConfig({ ...CONFIG, restoreWhenExpired: false });
	const sender = session();
	const receiver = session();
	await sender.fire("429");
	await receiver.boundary("before_agent_start");
	await sender.restore("anthropic --all");
	await sender.fire("429");
	await receiver.boundary();
	assert.deepEqual(sender.switched, [B, A, B]);
	assert.deepEqual(receiver.switched, [B]);
	assert.ok(marks().anthropic);
});

test("named broadcasts leave other originals and manual model choices alone", async () => {
	const s = session();
	await s.fire("429");
	await s.restore("kimi --all");
	await s.boundary();
	assert.deepEqual(s.switched, [B]);
	s.ctx.model = { provider: "kimi", id: "k" };
	await s.restore("anthropic");
	assert.deepEqual(s.switched, [B]);
});

test("turn_end limit: marks provider, switches to equivalent, drops failed attempt, records notice", async () => {
	const s = session();
	const r = await s.fire("429 rate_limit_error");
	assert.deepEqual(s.switched, [B]);
	assert.ok(marks().anthropic.until > Date.now() + 59 * 60_000); // default 60 min
	assert.match(s.notices[0][0], /^provider-fallback: anthropic\/a hit a usage\/rate limit \(~\d+ (min|h)\); continuing on openai\/b \(auto: 200k for openai\/b\)\.$/);
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

test("over-limit notice requests handoff now, then switches at the next recovered prompt", async () => {
	const main = session({ hasUI: true, tokens: 200_000, target: { contextWindow: 272_000, maxTokens: 128_000 } });
	const result = await main.fire("429");
	assert.equal(main.switched.length, 0);
	assert.ok(marks().anthropic);
	assert.match(main.notices[0][0], /fallback deferred: context 200k > auto: 72k for openai\/b/);
	assert.match(result.entries.at(-1).content, /context_handoff now.*next prompt/);
	main.ctx.getContextUsage = () => ({ tokens: 50_000 });
	await main.boundary("before_agent_start");
	assert.equal(main.switched.at(-1).id, B.id);
	assert.match(main.notices.at(-1)![0], /auto: 72k for openai\/b/);
	writeFileSync(stateFile, "{}");
	const headless = session({ hasUI: false, tokens: 250_000 });
	await headless.fire("429");
	assert.equal(headless.switched.length, 0);
	assert.match(headless.notices[0][0], /auto: 200k.*context_handoff now/);
});

test("context-budget config, per-current-model threshold and live session role are honored", async () => {
	writeFileSync(process.env.PI_CONTEXT_BUDGET_CONFIG!, JSON.stringify({ main: { handoff: 90_000 }, subagent: { handoff: 60_000 }, models: { "anthropic/a": { main: { handoff: 80_000 } } } }));
	const main = session({ hasUI: true, tokens: 85_000 });
	await main.fire("429");
	assert.match(main.notices[0][0], /auto: 80k/);
	const sub = session({ hasUI: false, tokens: 65_000 });
	await sub.fire("429");
	assert.match(sub.notices[0][0], /auto: 60k/);
	mkdirSync(join(process.env.PI_CONTEXT_BUDGET_STATE_DIR!, "status"));
	writeFileSync(join(process.env.PI_CONTEXT_BUDGET_STATE_DIR!, "status", "test-session.json"), JSON.stringify({ pid: process.pid, role: "main" }));
	const headlessMain = session({ hasUI: false, tokens: 85_000 });
	headlessMain.ctx.sessionManager = { getSessionId: () => "test-session" };
	await headlessMain.fire("429");
	assert.match(headlessMain.notices[0][0], /auto: 80k/);
});

test("numeric override allows a context larger than target auto allowance", async () => {
	writeConfig({ ...CONFIG, maxContextTokensForFallback: 100_000 });
	const s = session({ hasUI: true, tokens: 85_000, target: { contextWindow: 272_000, maxTokens: 128_000 } });
	await s.fire("429");
	assert.equal(s.switched.length, 1);
	assert.match(s.notices[0][0], /override: 100k/);
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
