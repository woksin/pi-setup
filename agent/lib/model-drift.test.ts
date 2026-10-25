import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriftTracker, expectedModel } from "./model-drift.ts";
import { ORIGINAL_ENTRY, publishFallbackState, readFallbackState, restoreOriginal } from "./provider-fallback-state.ts";
import driftExtension from "../extensions/model-drift.ts";
import fallbackExtension from "../extensions/provider-fallback.ts";

const A = { provider: "anthropic", id: "a" };
const B = { provider: "openai", id: "b" };

function agentDir(opts: { active?: string; mainModel?: string; settings?: object } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "drift-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(opts.settings ?? { defaultProvider: "anthropic", defaultModel: "a" }));
	if (opts.active) {
		mkdirSync(join(dir, "profiles", opts.active), { recursive: true });
		writeFileSync(join(dir, "profiles", "ACTIVE"), `${opts.active}\n`);
		if (opts.mainModel) writeFileSync(join(dir, "profiles", opts.active, "profile.json"), JSON.stringify({ mainModel: opts.mainModel }));
	}
	return dir;
}

test("expectedModel: profile mainModel wins, else settings, else undefined", () => {
	assert.deepEqual(expectedModel(agentDir({ active: "p", mainModel: "openai/b" })), { ref: "openai/b", from: "profile p" });
	assert.equal(expectedModel(agentDir({ active: "p" }))?.ref, "anthropic/a");
	assert.equal(expectedModel(agentDir())?.from, "settings.json default");
	assert.equal(expectedModel(agentDir({ active: "p", mainModel: "bogus" }))?.ref, "anthropic/a");
	assert.equal(expectedModel(agentDir({ settings: {} })), undefined);
	assert.equal(expectedModel("/nonexistent/dir"), undefined);
});

test("restoreOriginal: latest entry wins, null clears", () => {
	const e = (originalRef: string | null) => ({ type: "custom", customType: ORIGINAL_ENTRY, data: { originalRef, reason: "r" } });
	assert.equal(restoreOriginal([]), undefined);
	assert.equal(restoreOriginal([e("x/y"), { type: "message" }])?.originalRef, "x/y");
	assert.equal(restoreOriginal([e("x/y"), e(null)]), undefined);
	assert.equal(restoreOriginal([e("x/y"), e(null), e("p/q")])?.originalRef, "p/q");
});

test("tracker: matching model -> no status, no message", () => {
	const t = new DriftTracker();
	assert.deepEqual(t.evaluate("anthropic/a", { ref: "anthropic/a", from: "profile p" }, undefined), { status: undefined });
});

test("tracker: message once per pair, status persists, clears on match", () => {
	const t = new DriftTracker();
	const exp = { ref: "anthropic/a", from: "profile p" };
	const first = t.evaluate("openai/b", exp, undefined);
	assert.ok(first.message?.includes("/model anthropic/a"));
	assert.ok(first.status?.includes("model: openai/b (profile: anthropic/a"));
	const second = t.evaluate("openai/b", exp, undefined);
	assert.equal(second.message, undefined);
	assert.ok(second.status);
	assert.equal(t.evaluate("anthropic/a", exp, undefined).status, undefined);
	assert.equal(t.evaluate("openai/b", exp, undefined).message, undefined); // same pair again: still once per session
	assert.ok(t.evaluate("other/c", exp, undefined).message); // new pair
});

// ---- extension harness -------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => unknown;

function harness(opts: { dir: string; hasUI?: boolean; model?: typeof A; entries?: unknown[]; sessionId?: string }) {
	const handlers = new Map<string, Handler[]>();
	const statuses: (string | undefined)[] = [];
	const messages: any[] = [];
	const appended: { type: string; data: any }[] = [];
	const entries: unknown[] = [...(opts.entries ?? [])];
	const ctx: any = {
		hasUI: opts.hasUI ?? true,
		model: opts.model ?? A,
		ui: { setStatus: (_k: string, t: string | undefined) => statuses.push(t), notify: () => {} },
		sessionManager: { getBranch: () => entries, getSessionId: () => opts.sessionId ?? "s1" },
		modelRegistry: { find: (provider: string, id: string) => [A, B].find((m) => m.provider === provider && m.id === id) },
		getContextUsage: () => undefined,
	};
	const emit = async (name: string, event: any) => {
		let result: any;
		for (const h of handlers.get(name) ?? []) result = (await h(event, ctx)) ?? result;
		return result;
	};
	const pi: any = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		appendEntry: (type: string, data: any) => {
			appended.push({ type, data });
			entries.push({ type: "custom", customType: type, data });
		},
		sendMessage: (m: any) => messages.push(m),
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		setModel: async (m: typeof A) => {
			ctx.model = m;
			await emit("model_select", { source: "set", model: m });
			return true;
		},
	};
	driftExtension(pi);
	fallbackExtension(pi);
	return { ctx, emit, statuses, messages, appended, entries, pi };
}

function fallbackEnv(limited: boolean, restoreWhenExpired = true): void {
	const dir = mkdtempSync(join(tmpdir(), "fb-"));
	writeFileSync(join(dir, "c.json"), JSON.stringify({ enabled: true, restoreWhenExpired, limitPatterns: { anthropic: ["rate_limit_error"] }, pairs: [["anthropic/a", "openai/b"]] }));
	writeFileSync(join(dir, "s.json"), JSON.stringify(limited ? { anthropic: { until: Date.now() + 3_600_000, since: Date.now() } } : {}));
	process.env.PI_PROVIDER_FALLBACK_CONFIG = join(dir, "c.json");
	process.env.PI_PROVIDER_FALLBACK_STATE = join(dir, "s.json");
}

test("matching model: no status, no message, no log", async () => {
	fallbackEnv(false);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	const h = harness({ dir: "" });
	await h.emit("session_start", { reason: "startup" });
	await h.emit("before_agent_start", {});
	assert.ok(h.statuses.every((s) => s === undefined));
	assert.equal(h.messages.length, 0);
	assert.equal(h.appended.length, 0);
});

test("fallback switch: notice with reason, status, logged, original persisted; restore after expiry clears", async () => {
	fallbackEnv(true);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	const h = harness({ dir: "" });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.ctx.model, B);
	assert.equal(h.messages.length, 1);
	assert.match(h.messages[0].content, /openai\/b.*anthropic\/a.*provider-fallback moved this session: anthropic limited until/);
	assert.match(h.statuses.at(-1) ?? "", /via provider-fallback/);
	const persisted = h.appended.find((a) => a.type === ORIGINAL_ENTRY);
	assert.equal(persisted?.data.originalRef, "anthropic/a");
	const log = h.appended.find((a) => a.type === "model-drift");
	assert.equal(log?.data.source, "provider-fallback");
	assert.match(log?.data.reason, /limited until/);
	assert.equal(readFallbackState()?.originalRef, "anthropic/a");

	await h.emit("before_agent_start", {});
	assert.equal(h.messages.length, 1); // once per pair

	fallbackEnv(false); // limit expired
	await h.emit("before_agent_start", {});
	assert.equal(h.ctx.model, A);
	assert.equal(h.statuses.at(-1), undefined);
	assert.equal(restoreOriginal(h.entries), undefined);
	assert.equal(h.appended.some((a) => a.type === "model-drift" && a.data.drift === false), true);
});

test("user /model while on fallback: source user, original forgotten", async () => {
	fallbackEnv(true);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	const h = harness({ dir: "" });
	await h.emit("session_start", { reason: "startup" });
	h.ctx.model = { provider: "kimi", id: "k" };
	await h.emit("model_select", { source: "set", model: h.ctx.model });
	assert.match(h.statuses.at(-1) ?? "", /kimi\/k.*via user \/model/);
	assert.match(h.messages.at(-1).content, /you changed the model with \/model/);
	assert.equal(restoreOriginal(h.entries), undefined);
	assert.equal(readFallbackState(), undefined);
});

test("user /model on a clean session: source user", async () => {
	fallbackEnv(false);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	const h = harness({ dir: "" });
	await h.emit("session_start", { reason: "startup" });
	h.ctx.model = B;
	await h.emit("model_select", { source: "cycle", model: B });
	assert.match(h.statuses.at(-1) ?? "", /via user \/model/);
	assert.equal(h.messages.length, 1);
});

test("reload restores originalRef from entries and switches back once the limit is gone", async () => {
	fallbackEnv(false);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	publishFallbackState(undefined);
	const entries = [{ type: "custom", customType: ORIGINAL_ENTRY, data: { originalRef: "anthropic/a", destination: "openai/b", reason: "anthropic limited until 14:05" } }];
	const h = harness({ dir: "", model: B, entries });
	await h.emit("session_start", { reason: "reload" });
	assert.equal(h.ctx.model, A); // restored: limit expired
	assert.equal(h.statuses.at(-1), undefined);
});

test("reload while still limited: drift notice names provider-fallback, not profile/default", async () => {
	fallbackEnv(true);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	publishFallbackState(undefined);
	const entries = [{ type: "custom", customType: ORIGINAL_ENTRY, data: { originalRef: "anthropic/a", destination: "openai/b", reason: "anthropic limited until 14:05" } }];
	const h = harness({ dir: "", model: B, entries });
	await h.emit("session_start", { reason: "reload" });
	assert.equal(h.ctx.model, B);
	assert.match(h.messages[0].content, /provider-fallback moved this session: anthropic limited until 14:05/);
});

test("restore impossible: status says why", async () => {
	fallbackEnv(false, false);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	publishFallbackState(undefined);
	const entries = [{ type: "custom", customType: ORIGINAL_ENTRY, data: { originalRef: "anthropic/a", destination: "openai/b", reason: "r" } }];
	const h = harness({ dir: "", model: B, entries });
	await h.emit("session_start", { reason: "reload" });
	assert.match(h.statuses.at(-1) ?? "", /cannot switch back: restoreWhenExpired is disabled/);
});

test("subagent (no UI): skipped, nothing published or persisted", async () => {
	fallbackEnv(true);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	publishFallbackState(undefined);
	const h = harness({ dir: "", hasUI: false, model: B });
	await h.emit("session_start", { reason: "startup" });
	await h.emit("before_agent_start", {});
	assert.equal(h.statuses.length, 0);
	assert.equal(h.messages.length, 0);
	assert.equal(h.appended.length, 0);
	assert.equal(readFallbackState(), undefined);
});

test("stale record: current model differs from recorded destination -> not restored, clear persisted", async () => {
	fallbackEnv(false);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	publishFallbackState(undefined);
	const C = { provider: "kimi", id: "k" };
	const entries = [{ type: "custom", customType: ORIGINAL_ENTRY, data: { originalRef: "anthropic/a", destination: "openai/b", reason: "r" } }];
	const h = harness({ dir: "", model: C, entries });
	await h.emit("session_start", { reason: "reload" });
	assert.equal(h.ctx.model, C);
	assert.equal(restoreOriginal(h.entries), undefined);
	assert.equal(readFallbackState(), undefined);
});

test("legacy record without destination is treated as stale", async () => {
	fallbackEnv(false);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	publishFallbackState(undefined);
	const entries = [{ type: "custom", customType: ORIGINAL_ENTRY, data: { originalRef: "anthropic/a", reason: "r" } }];
	const h = harness({ dir: "", model: B, entries });
	await h.emit("session_start", { reason: "reload" });
	assert.equal(h.ctx.model, B);
});

test("published state of another session is ignored; shutdown clears it", async () => {
	fallbackEnv(true);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	const first = harness({ dir: "", sessionId: "old" });
	await first.emit("session_start", { reason: "startup" });
	assert.equal(readFallbackState()?.sessionId, "old");
	// a new session on B without any record, published state still the old session's
	fallbackEnv(false);
	publishFallbackState({ originalRef: "anthropic/a", reason: "OLD REASON", sessionId: "old" });
	const second = harness({ dir: "", model: B, sessionId: "new" });
	await second.emit("session_start", { reason: "new" });
	assert.ok(!second.messages[0].content.includes("OLD REASON"));
	assert.match(second.messages[0].content, /session started or was restored/);
	await first.emit("session_shutdown", {});
	assert.equal(readFallbackState(), undefined);
});

test("reload does not repeat the notice for an already announced pair", async () => {
	fallbackEnv(true);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	const h = harness({ dir: "" });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.messages.length, 1);
	publishFallbackState(undefined);
	const reloaded = harness({ dir: "", model: B, entries: h.entries });
	await reloaded.emit("session_start", { reason: "reload" });
	assert.equal(reloaded.messages.length, 0);
	assert.ok(reloaded.statuses.at(-1)); // status still shown
});

test("reactive turn_end limit: switches, persists destination, announces drift", async () => {
	fallbackEnv(false);
	process.env.PI_CODING_AGENT_DIR = agentDir();
	const h = harness({ dir: "" });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.messages.length, 0);
	const result = await h.emit("turn_end", {
		message: { role: "assistant", stopReason: "error", errorMessage: "rate_limit_error: slow down", provider: "anthropic", model: "a" },
		entries: [],
		messageEntryId: "m1",
	});
	assert.equal(h.ctx.model, B);
	assert.ok(result?.entries?.some((e: any) => e.type === "context_edit"));
	const persisted = h.appended.find((a) => a.type === ORIGINAL_ENTRY);
	assert.equal(persisted?.data.originalRef, "anthropic/a");
	assert.equal(persisted?.data.destination, "openai/b");
	assert.equal(h.messages.length, 1);
	assert.match(h.messages[0].content, /provider-fallback moved this session: anthropic\/a limited until/);
	assert.match(h.statuses.at(-1) ?? "", /via provider-fallback/);
});
