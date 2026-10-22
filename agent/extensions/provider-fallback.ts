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
	/** Main (UI) sessions whose context exceeds this many tokens are not switched to the fallback (default 150000; 0 disables). */
	maxContextTokensForFallback?: number;
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

export const DEFAULT_MAX_CONTEXT_TOKENS_FOR_FALLBACK = 150_000;

/**
 * Policy: do not move a large-context MAIN session onto the fallback provider (it re-reads the whole context
 * at the fallback's cost). Unknown context (null/undefined tokens) or a headless session (subagent) is allowed.
 */
export function fallbackContextVeto(
	config: { maxContextTokensForFallback?: number },
	isMainSession: boolean,
	tokens: number | null | undefined,
): string | undefined {
	const max = config.maxContextTokensForFallback ?? DEFAULT_MAX_CONTEXT_TOKENS_FOR_FALLBACK;
	if (!isMainSession || !(max > 0) || typeof tokens !== "number" || tokens <= max) return undefined;
	const k = (n: number) => `${Math.round(n / 1000)}k`;
	return `fallback skipped: context ${k(tokens)} > ${k(max)}; compact or hand off first`;
}

function refOf(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export default function (pi: ExtensionAPI) {
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
	function contextVeto(ctx: ExtensionContext, config: FallbackConfig): string | undefined {
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
		return fallbackContextVeto(config, ctx.hasUI, tokens);
	}

	/** Pre-emptive switch away from a marked provider, or back once the mark has expired. */
	async function preempt(ctx: ExtensionContext): Promise<void> {
		const config = loadConfig();
		const current = refOf(ctx.model);
		if (!config || !current) return;

		if (originalRef && originalRef !== current && originalDestination !== current) {
			// Stale record (e.g. restored from an entry after a /model change on another branch): never override the active model.
			forgetOriginal(ctx);
		}
		if (originalRef && originalRef !== current && config.restoreWhenExpired === false) {
			restoreNote = "restoreWhenExpired is disabled";
			publishState();
		} else if (originalRef && originalRef !== current) {
			const original = splitRef(originalRef);
			if (limitedUntil(original.provider) === undefined) {
				const failure = await switchTo(ctx, originalRef);
				if (!failure) {
					notify(ctx, `provider-fallback: ${original.provider} limit expired; back on ${originalRef}.`, "info");
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
		const veto = contextVeto(ctx, config);
		if (veto) {
			notify(ctx, `provider-fallback: ${currentProvider} is limited (${formatUntil(until)} left); ${veto}.`, "warning");
			return;
		}
		const reason = `${currentProvider} limited until ${untilClock(until)}`;
		const failure = await switchTo(ctx, target, { ref: originalRef ?? current, reason });
		if (failure) {
			notify(ctx, `provider-fallback: ${currentProvider} is limited but switching to ${target} failed: ${failure}`, "warning");
			return;
		}
		rememberOriginal(ctx, originalRef ?? current, reason, target);
		notify(ctx, `provider-fallback: ${currentProvider} limited (${formatUntil(until)} left); using ${target} instead of ${current}.`, "warning");
	}

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
			return {
				entries: [
					...event.entries,
					{ type: "custom_message" as const, customType: CUSTOM_TYPE, content: text, display: true, details: { from } },
				],
			};
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
		const veto = contextVeto(ctx, config);
		if (veto) return note(`provider-fallback: ${from} ${what} (${formatUntil(until)}); ${veto}. Not switching.`, "error");
		const reason = `${message.provider} ${kind === "limit" ? "limited" : "unavailable"} until ${untilClock(until)}`;
		const failure = await switchTo(ctx, target, { ref: originalRef ?? from, reason });
		if (failure) return note(`provider-fallback: ${from} hit a limit; switching to ${target} failed: ${failure}`, "error");

		fallbacksThisPrompt++;
		pendingContinue = true;
		rememberOriginal(ctx, originalRef ?? from, reason, target);
		const text = `provider-fallback: ${from} ${what} (${formatUntil(until)}); continuing on ${target}.`;
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
