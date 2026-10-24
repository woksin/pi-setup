/**
 * provider-fallback — automatic cross-provider model fallback on usage/rate limits.
 *
 * When an assistant turn ends with a limit error from provider X (patterns in the config),
 * the extension:
 *   1. records "X limited until T" in a shared state file (reset time parsed from the error
 *      text or the 429 response headers, otherwise `defaultLimitMinutes`);
 *   2. switches this session to the mapped equivalent model on the other provider, keeping
 *      the thinking level (pi clamps it to the target's capabilities);
 *   3. omits the failed attempt from model context and requests one continuation — either
 *      pi's own retry picks it up (Anthropic 429s are classed as retryable, so the retry now
 *      runs on the new model) or `agent_before_settle` continues the run.
 *
 * Loop safety: no switch to a provider that is itself marked limited (so X -> Y -> X cannot
 * happen until X's mark expires), at most `maxFallbacksPerPrompt` switches per prompt, and
 * non-limit errors (overloaded, network, refusals) are left entirely to pi — unless they match the
 * provider's `unavailablePatterns`, which are handled like a limit with a short `unavailableMinutes` mark.
 *
 * `chains` ("provider/model" -> ordered fallbacks) take precedence over `pairs`: the first chain entry
 * whose provider is not marked limited is used, so a chain can step past a limited provider.
 *
 * Pre-emptive switching: on session start and before every prompt, if the current model's
 * provider is marked limited and unexpired, the session switches to the equivalent first, so
 * new subagents and sessions do not each fail once. When the mark expires, a session that
 * this extension moved is switched back to its original model before the next prompt.
 *
 * Config: ~/.pi/agent/provider-fallback.json (override: PI_PROVIDER_FALLBACK_CONFIG).
 * State:  ~/.pi/agent/.provider-limits.json   (override: PI_PROVIDER_FALLBACK_STATE).
 * Subagents load it only when their agent file lists `provider-fallback` in `extensions:`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ORIGINAL_ENTRY, publishFallbackState, restoreOriginal, type OriginalEntryData } from "../lib/provider-fallback-state.ts";

interface FallbackConfig {
	enabled?: boolean;
	/** Used when neither the error text nor the response headers carry a reset time. */
	defaultLimitMinutes?: number;
	maxFallbacksPerPrompt?: number;
	/** Auto uses session handoff budget and the target model's input allowance; a number overrides it (0 disables). */
	maxContextTokensForFallback?: number | "auto";
	/** Share of target (contextWindow - maxTokens) usable before handing off (default 0.5). */
	fallbackContextRatio?: number;
	/** Switch back to the original model once its provider's limit mark has expired. */
	restoreWhenExpired?: boolean;
	/** provider id -> regex sources (case-insensitive) that identify a usage/rate-limit error. */
	limitPatterns?: Record<string, string[]>;
	/** Bidirectional equivalences, each as ["provider/model", "provider/model"]. */
	pairs?: [string, string][];
	/**
	 * Ordered fallbacks per model ("provider/model" -> ["provider/model", ...]), used before `pairs`. The first
	 * entry whose provider is not marked limited wins; keyed by the model this extension originally moved away from.
	 */
	chains?: Record<string, string[]>;
	/** provider id -> regex sources (case-insensitive) for "provider unavailable" errors (auth, overload, 5xx, timeouts) that also fall back. */
	unavailablePatterns?: Record<string, string[]>;
	/** How long an "unavailable" mark lasts (default 10). */
	unavailableMinutes?: number;
}

interface LimitEntry {
	until: number;
	since: number;
	model?: string;
	reason?: string;
}
type LimitState = Record<string, LimitEntry>;

const CUSTOM_TYPE = "provider-fallback";
const MIN_LIMIT_MS = 60_000;
const HEADER_MAX_AGE_MS = 60_000;

function configPath(): string {
	return process.env.PI_PROVIDER_FALLBACK_CONFIG || join(getAgentDir(), "provider-fallback.json");
}

function statePath(): string {
	return process.env.PI_PROVIDER_FALLBACK_STATE || join(getAgentDir(), ".provider-limits.json");
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function loadConfig(): FallbackConfig | undefined {
	const config = readJson<FallbackConfig>(configPath());
	if (!config || config.enabled === false) return undefined;
	return config;
}

function readState(now = Date.now()): LimitState {
	const raw = readJson<LimitState>(statePath()) ?? {};
	const live: LimitState = {};
	for (const [provider, entry] of Object.entries(raw)) {
		if (entry && typeof entry.until === "number" && entry.until > now) live[provider] = entry;
	}
	return live;
}

/** Merge one limit mark into the shared state (expired marks are pruned), written atomically. */
function markLimited(provider: string, entry: LimitEntry): void {
	const state = readState();
	const previous = state[provider];
	state[provider] = previous && previous.until > entry.until ? { ...entry, until: previous.until } : entry;
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function restorePath(): string {
	return join(dirname(statePath()), ".provider-restore.json");
}

function writeJson(path: string, value: object): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** Operator-requested restore; the signal never overrides a subsequent live limit mark. */
function clearLimits(provider: string | undefined, broadcast: boolean): void {
	const state = readState();
	if (provider) delete state[provider];
	writeJson(statePath(), provider ? state : {});
	if (!broadcast) return;
	const signals = readJson<Record<string, number>>(restorePath()) ?? {};
	const epoch = Math.max(Date.now(), ...Object.values(signals).filter(Number.isFinite)) + 1;
	signals[provider ?? "*"] = epoch;
	writeJson(restorePath(), signals);
}

function limitedUntil(provider: string): number | undefined {
	return readState()[provider]?.until;
}

function isLimited(provider: string): boolean {
	return limitedUntil(provider) !== undefined;
}

function matchesAny(patterns: string[] | undefined, errorMessage: string): boolean {
	if (!patterns?.length) return false;
	return patterns.some((source) => {
		try {
			return new RegExp(source, "i").test(errorMessage);
		} catch {
			return false;
		}
	});
}

function isLimitError(config: FallbackConfig, provider: string, errorMessage: string): boolean {
	return matchesAny(config.limitPatterns?.[provider], errorMessage);
}

/** "limit" (usage/rate limit), "unavailable" (configured outage patterns), or undefined (left to pi). */
export function classifyError(config: FallbackConfig, provider: string, errorMessage: string): "limit" | "unavailable" | undefined {
	if (isLimitError(config, provider, errorMessage)) return "limit";
	if (matchesAny(config.unavailablePatterns?.[provider], errorMessage)) return "unavailable";
	return undefined;
}

export function equivalentOf(config: FallbackConfig, ref: string): string | undefined {
	for (const [a, b] of config.pairs ?? []) {
		if (a === ref) return b;
		if (b === ref) return a;
	}
	return undefined;
}

/**
 * Where to go from `current`. A chain (keyed by `origin`, the model this extension moved away from, else `current`)
 * yields its first entry that is not `current` and whose provider is not limited; otherwise the pair equivalent of
 * `current`, if its provider is not limited. `blocked` lists configured candidates skipped because they are limited.
 */
export function selectFallback(
	config: FallbackConfig,
	current: string,
	origin: string | undefined,
	isLimited: (provider: string) => boolean,
): { target?: string; blocked: string[]; chain: boolean } {
	const chain = (origin && config.chains?.[origin]) || config.chains?.[current];
	const candidates = chain?.length ? chain.filter((ref) => ref !== current) : [equivalentOf(config, current)].filter((ref): ref is string => !!ref);
	const blocked: string[] = [];
	for (const ref of candidates) {
		if (!isLimited(splitRef(ref).provider)) return { target: ref, blocked, chain: !!chain?.length };
		blocked.push(ref);
	}
	return { blocked, chain: !!chain?.length };
}

function splitRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "Try again in ~8591 min", "try again in 2 hours", "retry after 30s" … → absolute ms. */
function resetFromText(text: string, now: number): number | undefined {
	const match = /(?:try again|retry|resets?)\s+(?:in|after)\s*~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(text);
	if (!match) return undefined;
	const unit = UNIT_MS[match[2][0].toLowerCase()];
	return unit ? now + Number(match[1]) * unit : undefined;
}

/** retry-after (seconds or HTTP date) and *-reset headers (epoch seconds/ms or ISO date) → latest absolute ms. */
function resetFromHeaders(headers: Record<string, string>, now: number): number | undefined {
	let best: number | undefined;
	const consider = (value: number) => {
		if (Number.isFinite(value) && value > now && (best === undefined || value > best)) best = value;
	};
	for (const [rawName, value] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		if (name === "retry-after") {
			const seconds = Number(value);
			consider(Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value));
		} else if (name.endsWith("-reset") || name.endsWith("-reset-at") || name.endsWith("-resets-at")) {
			const n = Number(value);
			if (Number.isFinite(n)) consider(n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000);
			else consider(Date.parse(value));
		}
	}
	return best;
}

function formatUntil(until: number): string {
	const minutes = Math.max(1, Math.round((until - Date.now()) / 60_000));
	return minutes >= 120 ? `~${Math.round(minutes / 60)} h` : `~${minutes} min`;
}

function untilClock(until: number): string {
	return new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const DEFAULT_MAX_CONTEXT_TOKENS_FOR_FALLBACK = "auto";
export const DEFAULT_FALLBACK_CONTEXT_RATIO = 0.5;

/** Auto policy uses the target input allowance and this session's handoff budget. Unknown usage remains allowed. */
type BudgetConfig = { main?: { handoff?: number }; subagent?: { handoff?: number }; models?: Record<string, Omit<BudgetConfig, "models">> };
type TargetContext = { provider: string; id: string; contextWindow?: number; maxTokens?: number };
const kTokens = (n: number) => `${Math.round(n / 1000)}k`;
const positive = (n: number | undefined, fallback: number) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;

export function fallbackContextLimit(config: Pick<FallbackConfig, "maxContextTokensForFallback" | "fallbackContextRatio">, main: boolean, target?: TargetContext, handoff = main ? 400_000 : 200_000): number {
	if (typeof config.maxContextTokensForFallback === "number") return config.maxContextTokensForFallback;
	const ratio = positive(config.fallbackContextRatio, DEFAULT_FALLBACK_CONTEXT_RATIO);
	const window = positive(target?.contextWindow, Infinity);
	const output = Math.max(0, target?.maxTokens ?? 0);
	return Math.min(handoff, ratio * Math.max(0, window - output));
}

export function fallbackContextVeto(config: Pick<FallbackConfig, "maxContextTokensForFallback" | "fallbackContextRatio">, main: boolean, tokens: number | null | undefined, context: { target?: TargetContext; handoff?: number } = {}): string | undefined {
	const { target, handoff } = context;
	const max = fallbackContextLimit(config, main, target, handoff);
	if (config.maxContextTokensForFallback === 0) return;
	if (typeof tokens !== "number" || tokens <= max) return;
	const ref = target ? `${target.provider}/${target.id}` : "target";
	return `fallback deferred: context ${kTokens(tokens)} > ${fallbackLimitLabel(config, max, ref)}; call context_handoff now (or /compact), then end this turn; switch to ${ref} at the next prompt after context recovery`;
}

function budgetStatus(ctx: ExtensionContext): { pid: number; role: string } | undefined {
	const id = ctx.sessionManager?.getSessionId?.();
	if (!id) return;
	const dir = process.env.PI_CONTEXT_BUDGET_STATE_DIR || join(getAgentDir(), "context-budget");
	return readJson(join(dir, "status", `${id}.json`));
}

function budgetRole(ctx: ExtensionContext): "main" | "subagent" {
	const status = budgetStatus(ctx);
	if (status?.pid === process.pid) return status.role === "subagent" ? "subagent" : "main";
	return ctx.hasUI ? "main" : "subagent";
}

function modelHandoff(config: BudgetConfig | undefined, model: string, kind: "main" | "subagent"): number | undefined {
	return config?.models?.[model]?.[kind]?.handoff;
}

/** Prefer the budget extension's current session role; config also supports per-current-model handoff thresholds. */
function sessionHandoff(ctx: ExtensionContext): { main: boolean; handoff: number } {
	const kind = budgetRole(ctx);
	const main = kind === "main";
	const config = readJson<BudgetConfig>(process.env.PI_CONTEXT_BUDGET_CONFIG || join(getAgentDir(), "context-budget.json"));
	const base = positive(config?.[kind]?.handoff, main ? 400_000 : 200_000);
	return { main, handoff: positive(modelHandoff(config, refOf(ctx.model) ?? "", kind), base) };
}

function restoreArgs(args: string): { provider?: string; broadcast: boolean } | undefined {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const providers = words.filter(word => !word.startsWith("--"));
	if (providers.length > 1) return;
	if (words.some(word => word.startsWith("--") && word !== "--all")) return;
	return { provider: providers[0], broadcast: words.includes("--all") };
}
function fallbackLimitLabel(config: FallbackConfig, max: number, ref: string): string {
	const mode = typeof config.maxContextTokensForFallback === "number" ? "override" : "auto";
	return `${mode}: ${kTokens(max)} for ${ref}`;
}

function contextLimitLabel(ctx: ExtensionContext, config: FallbackConfig, targetRef: string): string {
	const ref = splitRef(targetRef);
	const target = ctx.modelRegistry.find(ref.provider, ref.id) ?? ref;
	const budget = sessionHandoff(ctx);
	return fallbackLimitLabel(config, fallbackContextLimit(config, budget.main, target, budget.handoff), targetRef);
}

const restoreEnabled = (config: FallbackConfig, requested: boolean) => requested || config.restoreWhenExpired !== false;
const restoreReason = (requested: boolean) => requested ? "restore requested" : "limit expired";

function fallbackNote(text: string, from: string, entries: readonly object[]) {
	return { entries: [...entries, { type: "custom_message" as const, customType: CUSTOM_TYPE, content: text, display: true, details: { from } }] };
}

function refOf(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export default function (pi: ExtensionAPI) {
	let seenRestore = readJson<Record<string, number>>(restorePath()) ?? {};
	let fallbacksThisPrompt = 0;
	let pendingContinue = false;
	/** The model this extension moved the session away from (cleared on a manual model change). */
	let originalRef: string | undefined;
	let selfSwitching = false;
	let originalReason: string | undefined;
	/** The model fallback switched TO; a persisted original is only restorable while the session is still on it. */
	let originalDestination: string | undefined;
	let sessionId: string | undefined;
	let restoreNote: string | undefined;
	/** Original + reason published while a fallback switch is in flight (before it is remembered). */
	let pendingOriginal: { ref: string; reason: string } | undefined;

	/** Remember (and persist, main sessions only) the model we moved away from, so a reload can restore it. */
	function rememberOriginal(ctx: ExtensionContext, ref: string, reason: string, destination: string): void {
		originalRef = ref;
		originalDestination = destination;
		originalReason = reason;
		restoreNote = undefined;
		publishState();
		if (ctx.hasUI) pi.appendEntry<OriginalEntryData>(ORIGINAL_ENTRY, { originalRef: ref, destination, reason, at: Date.now() });
	}

	function forgetOriginal(ctx: ExtensionContext): void {
		const had = originalRef !== undefined;
		originalRef = undefined;
		originalReason = undefined;
		originalDestination = undefined;
		restoreNote = undefined;
		publishState();
		if (had && ctx.hasUI) pi.appendEntry<OriginalEntryData>(ORIGINAL_ENTRY, { originalRef: null, at: Date.now() });
	}

	/** Main sessions only: subagents share this process and must not overwrite the main session's state. */
	let isMain = false;
	function publishState(): void {
		if (!isMain) return;
		publishFallbackState(
			originalRef || pendingOriginal || selfSwitching
				? {
						originalRef: originalRef ?? pendingOriginal?.ref,
						reason: originalRef ? originalReason : pendingOriginal?.reason,
						at: Date.now(),
						sessionId,
						switching: selfSwitching,
						restoreNote,
					}
				: undefined,
		);
	}
	let lastLimitHeaders: { at: number; provider?: string; headers: Record<string, string> } | undefined;

	/** Switch to `ref`, keeping the current thinking level (pi clamps it to the target). */
	async function switchTo(ctx: ExtensionContext, ref: string, pending?: { ref: string; reason: string }): Promise<string | undefined> {
		const { provider, id } = splitRef(ref);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) return `model ${ref} not found`;
		const level = pi.getThinkingLevel();
		selfSwitching = true;
		pendingOriginal = pending;
		publishState();
		try {
			if (!(await pi.setModel(model))) return `no credentials for ${provider}`;
			pi.setThinkingLevel(level);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			selfSwitching = false;
			pendingOriginal = undefined;
			publishState();
		}
		return undefined;
	}

	function notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error"): void {
		try {
			ctx.ui.notify(text, type);
		} catch {
			// No UI (headless subagent): the custom entry in the session transcript records it.
		}
	}

	let unknownContextLogged = false;

	/** Veto text when this session's context is too large to move to the fallback; undefined = allowed. */
	function contextVeto(ctx: ExtensionContext, config: FallbackConfig, targetRef: string): string | undefined {
		let tokens: number | null | undefined;
		try {
			tokens = ctx.getContextUsage()?.tokens;
		} catch {
			tokens = undefined;
		}
		if (tokens == null && ctx.hasUI && !unknownContextLogged) {
			unknownContextLogged = true;
			console.error("provider-fallback: context size unknown; allowing fallback (logged once).");
		}
		const ref = splitRef(targetRef);
		const target = ctx.modelRegistry.find(ref.provider, ref.id) ?? ref;
		const budget = sessionHandoff(ctx);
		return fallbackContextVeto(config, budget.main, tokens, { target, handoff: budget.handoff });
	}

	/** Pre-emptive switch away from a marked provider, or back once the mark has expired. */
	async function preempt(ctx: ExtensionContext, requested = false): Promise<void> {
		const config = loadConfig();
		const current = refOf(ctx.model);
		if (!config || !current) return;

		if (originalRef && originalRef !== current && originalDestination !== current) {
			// Stale record (e.g. restored from an entry after a /model change on another branch): never override the active model.
			forgetOriginal(ctx);
		}
		if (originalRef && originalRef !== current && !restoreEnabled(config, requested)) {
			restoreNote = "restoreWhenExpired is disabled";
			publishState();
		} else if (originalRef && originalRef !== current) {
			const original = splitRef(originalRef);
			if (limitedUntil(original.provider) === undefined) {
				const failure = await switchTo(ctx, originalRef);
				if (!failure) {
					notify(ctx, `provider-fallback: ${original.provider} ${restoreReason(requested)}; back on ${originalRef}.`, "info");
					forgetOriginal(ctx);
					return;
				}
				restoreNote = `${originalRef}: ${failure}`;
				publishState();
			}
		}

		const currentProvider = splitRef(current).provider;
		const until = limitedUntil(currentProvider);
		if (until === undefined) return;
		const { target } = selectFallback(config, current, originalRef, isLimited);
		if (!target) return; // no equivalent, or every candidate limited: nothing to gain
		const veto = contextVeto(ctx, config, target);
		if (veto) {
			notify(ctx, `provider-fallback: ${currentProvider} is limited (${formatUntil(until)} left); ${veto}.`, "warning");
			return;
		}
		const reason = `${currentProvider} limited until ${untilClock(until)}`;
		const allowance = contextLimitLabel(ctx, config, target);
		const failure = await switchTo(ctx, target, { ref: originalRef ?? current, reason });
		if (failure) {
			notify(ctx, `provider-fallback: ${currentProvider} is limited but switching to ${target} failed: ${failure}`, "warning");
			return;
		}
		rememberOriginal(ctx, originalRef ?? current, reason, target);
		notify(ctx, `provider-fallback: ${currentProvider} limited (${formatUntil(until)} left); using ${target} instead of ${current} (${allowance}).`, "warning");
	}

	async function checkRestore(ctx: ExtensionContext): Promise<void> {
		const signals = readJson<Record<string, number>>(restorePath()) ?? {};
		const provider = originalRef && splitRef(originalRef).provider;
		const newer = (key: string) => Number.isFinite(signals[key]) && signals[key] > (seenRestore[key] ?? 0);
		const requested = !!provider && (newer("*") || newer(provider));
		seenRestore = signals;
		if (requested) await preempt(ctx, true);
	}

	pi.registerCommand?.("provider-restore", {
		description: "Clear provider limits and restore this session: [provider] [--all (broadcast)]",
		handler: async (args, ctx) => {
			const parsed = restoreArgs(args);
			if (!parsed) {
				notify(ctx, "Usage: /provider-restore [provider] [--all]", "warning");
				return;
			}
			const { provider, broadcast } = parsed;
			clearLimits(provider, broadcast);
			const affectsOriginal = !provider || splitRef(originalRef ?? "").provider === provider;
			if (affectsOriginal) await preempt(ctx, true);
			notify(ctx, `provider-fallback: cleared ${provider ?? "all provider"} limits${broadcast ? "; restore broadcast sent" : ""}.`, "info");
		},
	});

	pi.on("turn_start", async (_event, ctx) => { await checkRestore(ctx); });

	pi.on("session_start", async (_event, ctx) => {
		fallbacksThisPrompt = 0;
		pendingContinue = false;
		isMain = ctx.hasUI;
		originalRef = undefined;
		originalReason = undefined;
		originalDestination = undefined;
		restoreNote = undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = undefined;
		}
		if (isMain) {
			// A reload / context reset loses the in-memory originalRef: take it from the latest persisted entry.
			try {
				const restored = restoreOriginal(ctx.sessionManager.getBranch());
				originalRef = restored?.originalRef;
				originalReason = restored?.reason;
				originalDestination = restored?.destination;
			} catch {
				// entries unavailable: behave as before
			}
		}
		publishState();
		await preempt(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (isMain) publishFallbackState(undefined);
		isMain = false;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		fallbacksThisPrompt = 0;
		pendingContinue = false;
		await checkRestore(ctx);
		await preempt(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (!selfSwitching && event.source !== "restore") forgetOriginal(ctx);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status === 429) lastLimitHeaders = { at: Date.now(), provider: ctx.model?.provider, headers: event.headers };
	});

	// A new model request is starting (pi's retry or our continuation): the pending one is consumed.
	pi.on("agent_start", async () => {
		pendingContinue = false;
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error" || !message.errorMessage) return;
		const config = loadConfig();
		const kind = config && classifyError(config, message.provider, message.errorMessage);
		if (!config || !kind) return;
		const what = kind === "limit" ? "hit a usage/rate limit" : "is unavailable";

		const now = Date.now();
		const headers =
			lastLimitHeaders && now - lastLimitHeaders.at < HEADER_MAX_AGE_MS && lastLimitHeaders.provider === message.provider
				? resetFromHeaders(lastLimitHeaders.headers, now)
				: undefined;
		lastLimitHeaders = undefined;
		const until = Math.max(
			now + MIN_LIMIT_MS,
			kind === "unavailable"
				? now + (config.unavailableMinutes ?? 10) * 60_000
				: (resetFromText(message.errorMessage, now) ?? headers ?? now + (config.defaultLimitMinutes ?? 60) * 60_000),
		);
		const from = `${message.provider}/${message.model}`;
		markLimited(message.provider, { until, since: now, model: from, reason: message.errorMessage.slice(0, 200) });

		const note = (text: string, type: "info" | "warning" | "error") => {
			notify(ctx, text, type);
			return fallbackNote(text, from, event.entries);
		};

		const selection = selectFallback(config, from, originalRef, isLimited);
		const target = selection.target;
		if (!target && !selection.blocked.length) return note(`provider-fallback: ${from} ${what} and has no configured equivalent.`, "error");
		if (!target && selection.chain) {
			const list = selection.blocked.map((ref) => `${ref} (${formatUntil(limitedUntil(splitRef(ref).provider) ?? now)})`).join(", ");
			return note(
				`provider-fallback: ${from} ${what} (${formatUntil(until)}) and every fallback is limited — ${list}. Not switching; stop and wait or change plans.`,
				"error",
			);
		}
		if (!target) {
			const targetProvider = splitRef(selection.blocked[0]).provider;
			const targetUntil = limitedUntil(targetProvider) ?? now;
			return note(
				`provider-fallback: both providers are limited — ${message.provider} (${formatUntil(until)}) and ${targetProvider} (${formatUntil(targetUntil)}). Not switching; stop and wait or change plans.`,
				"error",
			);
		}
		if (fallbacksThisPrompt >= (config.maxFallbacksPerPrompt ?? 2)) {
			return note(`provider-fallback: ${from} hit a limit, but the per-prompt fallback cap was reached. Not switching.`, "error");
		}
		const veto = contextVeto(ctx, config, target);
		if (veto) return note(`provider-fallback: ${from} ${what} (${formatUntil(until)}); ${veto}.`, "error");
		const reason = `${message.provider} ${kind === "limit" ? "limited" : "unavailable"} until ${untilClock(until)}`;
		const allowance = contextLimitLabel(ctx, config, target);
		const failure = await switchTo(ctx, target, { ref: originalRef ?? from, reason });
		if (failure) return note(`provider-fallback: ${from} hit a limit; switching to ${target} failed: ${failure}`, "error");

		fallbacksThisPrompt++;
		pendingContinue = true;
		rememberOriginal(ctx, originalRef ?? from, reason, target);
		const text = `provider-fallback: ${from} ${what} (${formatUntil(until)}); continuing on ${target} (${allowance}).`;
		notify(ctx, text, "warning");
		return {
			entries: [
				...event.entries,
				// Drop the failed attempt from model context so the run can continue from the prior message.
				{ type: "context_edit" as const, targetId: event.messageEntryId, replacement: null },
				// Record only (not model context): a message here would become the prompt the new model answers.
				{ type: "custom" as const, customType: CUSTOM_TYPE, data: { text, from, to: target, until } },
			],
		};
	});

	// Non-retryable limit errors (e.g. ChatGPT usage limits) reach settlement: continue once on the new model.
	pi.on("agent_before_settle", async (event) => {
		if (!pendingContinue) return;
		pendingContinue = false;
		return { entries: event.entries, continue: true };
	});
}
