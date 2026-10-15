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
 * non-limit errors (overloaded, network, refusals) are left entirely to pi.
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

interface FallbackConfig {
	enabled?: boolean;
	/** Used when neither the error text nor the response headers carry a reset time. */
	defaultLimitMinutes?: number;
	maxFallbacksPerPrompt?: number;
	/** Switch back to the original model once its provider's limit mark has expired. */
	restoreWhenExpired?: boolean;
	/** provider id -> regex sources (case-insensitive) that identify a usage/rate-limit error. */
	limitPatterns?: Record<string, string[]>;
	/** Bidirectional equivalences, each as ["provider/model", "provider/model"]. */
	pairs?: [string, string][];
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

function isLimitError(config: FallbackConfig, provider: string, errorMessage: string): boolean {
	const patterns = config.limitPatterns?.[provider];
	if (!patterns?.length) return false;
	return patterns.some((source) => {
		try {
			return new RegExp(source, "i").test(errorMessage);
		} catch {
			return false;
		}
	});
}

function equivalentOf(config: FallbackConfig, ref: string): string | undefined {
	for (const [a, b] of config.pairs ?? []) {
		if (a === ref) return b;
		if (b === ref) return a;
	}
	return undefined;
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

function refOf(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export default function (pi: ExtensionAPI) {
	let fallbacksThisPrompt = 0;
	let pendingContinue = false;
	/** The model this extension moved the session away from (cleared on a manual model change). */
	let originalRef: string | undefined;
	let selfSwitching = false;
	let lastLimitHeaders: { at: number; provider?: string; headers: Record<string, string> } | undefined;

	/** Switch to `ref`, keeping the current thinking level (pi clamps it to the target). */
	async function switchTo(ctx: ExtensionContext, ref: string): Promise<string | undefined> {
		const { provider, id } = splitRef(ref);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) return `model ${ref} not found`;
		const level = pi.getThinkingLevel();
		selfSwitching = true;
		try {
			if (!(await pi.setModel(model))) return `no credentials for ${provider}`;
			pi.setThinkingLevel(level);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			selfSwitching = false;
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

	/** Pre-emptive switch away from a marked provider, or back once the mark has expired. */
	async function preempt(ctx: ExtensionContext): Promise<void> {
		const config = loadConfig();
		const current = refOf(ctx.model);
		if (!config || !current) return;

		if (originalRef && config.restoreWhenExpired !== false && originalRef !== current) {
			const original = splitRef(originalRef);
			if (limitedUntil(original.provider) === undefined) {
				const failure = await switchTo(ctx, originalRef);
				if (!failure) {
					notify(ctx, `provider-fallback: ${original.provider} limit expired; back on ${originalRef}.`, "info");
					originalRef = undefined;
					return;
				}
			}
		}

		const currentProvider = splitRef(current).provider;
		const until = limitedUntil(currentProvider);
		if (until === undefined) return;
		const target = equivalentOf(config, current);
		if (!target) return;
		if (limitedUntil(splitRef(target).provider) !== undefined) return; // both limited: nothing to gain
		const failure = await switchTo(ctx, target);
		if (failure) {
			notify(ctx, `provider-fallback: ${currentProvider} is limited but switching to ${target} failed: ${failure}`, "warning");
			return;
		}
		originalRef ??= current;
		notify(ctx, `provider-fallback: ${currentProvider} limited (${formatUntil(until)} left); using ${target} instead of ${current}.`, "warning");
	}

	pi.on("session_start", async (_event, ctx) => {
		fallbacksThisPrompt = 0;
		pendingContinue = false;
		await preempt(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		fallbacksThisPrompt = 0;
		pendingContinue = false;
		await preempt(ctx);
	});

	pi.on("model_select", async (event) => {
		if (!selfSwitching && event.source !== "restore") originalRef = undefined;
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
		if (!config || !isLimitError(config, message.provider, message.errorMessage)) return;

		const now = Date.now();
		const headers =
			lastLimitHeaders && now - lastLimitHeaders.at < HEADER_MAX_AGE_MS && lastLimitHeaders.provider === message.provider
				? resetFromHeaders(lastLimitHeaders.headers, now)
				: undefined;
		lastLimitHeaders = undefined;
		const until = Math.max(
			now + MIN_LIMIT_MS,
			resetFromText(message.errorMessage, now) ?? headers ?? now + (config.defaultLimitMinutes ?? 60) * 60_000,
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

		const target = equivalentOf(config, from);
		if (!target) return note(`provider-fallback: ${from} hit a usage/rate limit and has no configured equivalent.`, "error");
		const targetProvider = splitRef(target).provider;
		const targetUntil = limitedUntil(targetProvider);
		if (targetUntil !== undefined) {
			return note(
				`provider-fallback: both providers are limited — ${message.provider} (${formatUntil(until)}) and ${targetProvider} (${formatUntil(targetUntil)}). Not switching; stop and wait or change plans.`,
				"error",
			);
		}
		if (fallbacksThisPrompt >= (config.maxFallbacksPerPrompt ?? 2)) {
			return note(`provider-fallback: ${from} hit a limit, but the per-prompt fallback cap was reached. Not switching.`, "error");
		}
		const failure = await switchTo(ctx, target);
		if (failure) return note(`provider-fallback: ${from} hit a limit; switching to ${target} failed: ${failure}`, "error");

		fallbacksThisPrompt++;
		pendingContinue = true;
		originalRef ??= from;
		const text = `provider-fallback: ${from} hit a usage/rate limit (${formatUntil(until)}); continuing on ${target}.`;
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
