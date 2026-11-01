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
 * Provider pins: `providerPins` maps a session id (or a prefix of at least 8 characters) to the provider that
 * session must stay on. The pin also covers subagents it spawns (their session header names the spawner in
 * `parentSession`). A pinned session never switches, pre-empts or restores to another provider; with no
 * allowed fallback it stalls on the limit and `resumeAfterLimit` continues it once the limit clears.
 * Machine-local pins go in `provider-pins.json` beside the config (override: PI_PROVIDER_PINS).
 *
 * Config: ~/.pi/agent/provider-fallback.json (override: PI_PROVIDER_FALLBACK_CONFIG).
 * State:  ~/.pi/agent/.provider-limits.json   (override: PI_PROVIDER_FALLBACK_STATE).
 * Subagents load it only when their agent file lists `provider-fallback` in `extensions:`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ORIGINAL_ENTRY, publishFallbackState, restoreManualPin, restoreOriginal, type OriginalEntryData } from "../lib/provider-fallback-state.ts";
import { codeFingerprint, fallbackStatusLines } from "../lib/provider-fallback-status.ts";
import {
	blockingMark, clearForSelection, clearOnSuccess, clearProvider, limitScope, markKeyFor, merge, readMarks, updateMarks,
	type Classify, type MarkEntry,
} from "../lib/provider-limit-marks.ts";

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
	/** Re-prompt idle main sessions whose last turn failed on a rate limit once it clears (default true). */
	resumeAfterLimit?: boolean;
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
	/** provider id -> extra regex sources (case-insensitive) marking a limit error as account-wide (all models) instead of per model. */
	accountWidePatterns?: Record<string, string[]>;
	/** Session id (or prefix of at least 8 characters) -> provider that session and its subagents must stay on. */
	providerPins?: Record<string, string>;
}

const MAX_LINEAGE_DEPTH = 8;

function readSessionHeader(file: string): { id?: string; parentSession?: string } | undefined {
	try {
		const fd = openSync(file, "r");
		try {
			const buffer = Buffer.alloc(8192);
			const read = readSync(fd, buffer, 0, buffer.length, 0);
			return JSON.parse(buffer.toString("utf8", 0, read).split("\n")[0]);
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

type LineageSource = { getSessionId?: () => string | undefined; getHeader?: () => { id?: string; parentSession?: string } | null } | undefined;

/** This session's id followed by its spawners' ids (subagents and forks record `parentSession`), nearest first. */
export function sessionLineage(manager: LineageSource, readHeader = readSessionHeader): string[] {
	const ids: string[] = [];
	let header: { id?: string; parentSession?: string } | null | undefined;
	try {
		header = manager?.getHeader?.();
		const id = manager?.getSessionId?.() ?? header?.id;
		if (typeof id === "string" && id) ids.push(id);
	} catch {
		return ids;
	}
	let parent = header?.parentSession;
	for (let depth = 0; parent && depth < MAX_LINEAGE_DEPTH; depth++) {
		const next = readHeader(parent);
		const id = typeof next?.id === "string" ? next.id : /_([0-9a-f-]{36})\.jsonl$/i.exec(parent)?.[1];
		if (!id || ids.includes(id)) break;
		ids.push(id);
		parent = typeof next?.parentSession === "string" ? next.parentSession : undefined;
	}
	return ids;
}

const MAIN_LINEAGE = Symbol.for("pi.provider-fallback.main-lineage");

/**
 * The process root's lineage, shared process-wide: subagents run in the root session's process, and in-memory
 * subagent sessions (the default for nested agents) carry no `parentSession`, so they inherit pins through this.
 * Pins are meant for root sessions; a pin on an intermediate subagent reaches only its persisted descendants.
 */
export function setProcessMainLineage(ids: string[]): void {
	(globalThis as Record<symbol, unknown>)[MAIN_LINEAGE] = ids;
}

function processMainLineage(): string[] {
	const ids = (globalThis as Record<symbol, unknown>)[MAIN_LINEAGE];
	return Array.isArray(ids) ? ids : [];
}

/** The provider the nearest pinned session in `lineage` must stay on, if any. */
export function pinnedProvider(config: FallbackConfig, lineage: string[]): string | undefined {
	const pins = Object.entries(config.providerPins ?? {}).filter(([key, provider]) => key.length >= 8 && typeof provider === "string" && provider);
	for (const id of lineage) {
		const pin = pins.find(([key]) => id.startsWith(key));
		if (pin) return pin[1];
	}
	return undefined;
}

type StalledLimit = { provider: string; ref: string; since: number; ctx: ExtensionContext };

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

/** Machine-local pins (session ids stay out of the published config): { "<session id or prefix>": "<provider>" }. */
function pinsPath(): string {
	return process.env.PI_PROVIDER_PINS || join(dirname(configPath()), "provider-pins.json");
}

function loadConfig(): FallbackConfig | undefined {
	const config = readJson<FallbackConfig>(configPath());
	if (!config || config.enabled === false) return undefined;
	const local = readJson<Record<string, string>>(pinsPath());
	return local && typeof local === "object" ? { ...config, providerPins: { ...config.providerPins, ...local } } : config;
}

const classify: Classify = (provider, text) => limitScope(loadConfig() ?? {}, provider, text);

/** Merge one limit mark (key = provider for account-wide, provider/id for a model) under the shared-state lock. */
function markLimited(key: string, entry: MarkEntry): void {
	updateMarks(statePath(), (raw) => merge(raw, key, entry, Date.now()), { additive: true });
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
	updateMarks(statePath(), (raw) => (provider ? clearProvider(raw, provider) : {}));
	if (!broadcast) return;
	const signals = readJson<Record<string, number>>(restorePath()) ?? {};
	const epoch = Math.max(Date.now(), ...Object.values(signals).filter(Number.isFinite)) + 1;
	signals[provider ?? "*"] = epoch;
	writeJson(restorePath(), signals);
}

/** When the live mark blocking `ref` (its provider's account mark or its own model mark) expires. */
function limitedUntil(ref: string): number | undefined {
	return blockingMark(readMarks(statePath()), ref, Date.now(), classify)?.until;
}

function isLimited(ref: string): boolean {
	return limitedUntil(ref) !== undefined;
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
	isLimited: (ref: string) => boolean,
	pin?: string,
): { target?: string; blocked: string[]; chain: boolean } {
	const chain = (origin && config.chains?.[origin]) || config.chains?.[current];
	const configured = chain?.length ? chain.filter((ref) => ref !== current) : [equivalentOf(config, current)].filter((ref): ref is string => !!ref);
	const candidates = pin ? configured.filter((ref) => splitRef(ref).provider === pin) : configured;
	const blocked: string[] = [];
	for (const ref of candidates) {
		if (!isLimited(ref)) return { target: ref, blocked, chain: !!chain?.length };
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

/** Directory watches survive atomic state-file replacement; the slow timer also notices expiry/missed events. */
class LimitRecoveryWatch {
	private watcher?: FSWatcher;
	private debounce?: ReturnType<typeof setTimeout>;
	private timer?: ReturnType<typeof setInterval>;

	private readonly check: () => Promise<void>;

	constructor(check: () => Promise<void>) { this.check = check; }

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.schedule(), 60_000);
		this.timer.unref();
		try {
			this.watcher = watch(dirname(statePath()), (_event, filename) => {
				if (!filename || [basename(statePath()), basename(restorePath())].includes(String(filename))) this.schedule();
			});
			this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; });
			this.watcher.unref();
		} catch {
			// A missing/unwatchable directory is covered by the slow timer.
		}
	}

	schedule(): void {
		clearTimeout(this.debounce);
		this.debounce = setTimeout(() => {
			void this.check().catch(error => console.error("provider-fallback: limit recovery failed:", error));
		}, 100);
		this.debounce.unref();
	}

	stop(): void {
		this.watcher?.close();
		this.watcher = undefined;
		clearTimeout(this.debounce);
		clearInterval(this.timer);
		this.debounce = undefined;
		this.timer = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let seenRestore = readJson<Record<string, number>>(restorePath()) ?? {};
	let fallbacksThisPrompt = 0;
	let pendingContinue = false;
	/** The model this extension moved the session away from (cleared on a manual model change). */
	let originalRef: string | undefined;
	/** The one fallback-initiated setModel in flight; its model_select is ours, any other `set`/`cycle` is the user's. */
	let inFlight: { ref: string; seen: boolean } | undefined;
	let switchChain: Promise<unknown> = Promise.resolve();
	/** Model the user picked manually (pinned: never pre-empted away), and a counter bumped on every manual pick. */
	let manualRef: string | undefined;
	/** This session and its spawners, nearest first (for `providerPins`); set at session_start. */
	let lineage: string[] = [];
	/** Own lineage first; a subagent also inherits the pin of the main session hosting it. */
	const pinFor = (config: FallbackConfig) => pinnedProvider(config, isMain ? lineage : [...lineage, ...processMainLineage()]);
	let selectionGen = 0;
	const SUPERSEDED = "superseded by your manual model selection";
	/** Start time and selection generation of the request in flight (set at turn_start, consumed at turn_end). */
	let request: { at: number; gen: number } | undefined;
	let originalUntil: number | undefined;
	let uiCtx: ExtensionContext | undefined;
	const commandRegistered = typeof pi.registerCommand === "function";
	const watchedFiles = () => ["extensions/provider-fallback.ts", "lib/provider-limit-marks.ts", "lib/provider-fallback-status.ts", "lib/provider-fallback-state.ts"].map((file) => join(getAgentDir(), file));
	const loadedPrint = codeFingerprint(watchedFiles());
	let originalReason: string | undefined;
	/** The model fallback switched TO; a persisted original is only restorable while the session is still on it. */
	let originalDestination: string | undefined;
	let sessionId: string | undefined;
	let restoreNote: string | undefined;
	/** Original + reason published while a fallback switch is in flight (before it is remembered). */
	let pendingOriginal: { ref: string; reason: string } | undefined;

	/** Remember (and persist, main sessions only) the model we moved away from, so a reload can restore it. */
	function rememberOriginal(ctx: ExtensionContext, { ref, reason, destination, until }: { ref: string; reason: string; destination: string; until?: number }): void {
		originalRef = ref;
		originalDestination = destination;
		originalReason = reason;
		originalUntil = until;
		manualRef = undefined; // a reactive fallback moved the session off the pinned model
		restoreNote = undefined;
		publishState();
		if (ctx.hasUI) pi.appendEntry<OriginalEntryData>(ORIGINAL_ENTRY, { originalRef: ref, destination, reason, until, at: Date.now() });
	}

	function forgetOriginal(ctx: ExtensionContext): void {
		const had = originalRef !== undefined;
		originalRef = undefined;
		originalReason = undefined;
		originalDestination = undefined;
		originalUntil = undefined;
		restoreNote = undefined;
		publishState();
		if (had && ctx.hasUI) pi.appendEntry<OriginalEntryData>(ORIGINAL_ENTRY, { originalRef: null, at: Date.now() });
	}

	/** Main sessions only: subagents share this process and must not overwrite the main session's state. */
	let isMain = false;
	function publishState(): void {
		renderStatus();
		if (!isMain) return;
		publishFallbackState(
			originalRef || pendingOriginal || inFlight
				? {
						originalRef: originalRef ?? pendingOriginal?.ref,
						reason: originalRef ? originalReason : pendingOriginal?.reason,
						at: Date.now(),
						sessionId,
						switching: inFlight !== undefined,
						restoreNote,
					}
				: undefined,
		);
	}

	/** Persistent widget while fallback holds the session (footer statuses share one truncated line). Ctx may be stale after a reload. */
	function renderStatus(): void {
		try {
			const ui = uiCtx?.ui;
			if (!ui?.setWidget) return;
			if (!originalRef) return ui.setWidget("provider-fallback", undefined);
			const lines = fallbackStatusLines({
				originalRef,
				current: originalDestination,
				reason: originalReason,
				until: originalUntil,
				provider: splitRef(originalRef).provider,
				commandRegistered,
				restoreNote,
				stale: codeFingerprint(watchedFiles()) !== loadedPrint,
			});
			ui.setWidget("provider-fallback", lines, { placement: "belowEditor" });
		} catch {
			// stale context or no widget support
		}
	}
	let lastLimitHeaders: { at: number; provider?: string; headers: Record<string, string> } | undefined;
	let stalledLimit: StalledLimit | undefined;
	let checkingRecovery = false;
	const recoveryWatch = new LimitRecoveryWatch(resumeStalled);

	function clearStall(): void {
		stalledLimit = undefined;
		recoveryWatch.stop();
	}

	function recordStall(episode: StalledLimit, config: FallbackConfig, kind: ReturnType<typeof classifyError>): void {
		if (kind !== "limit") return;
		if (config.resumeAfterLimit === false || budgetRole(episode.ctx) !== "main") return;
		stalledLimit = episode;
		recoveryWatch.start();
	}

	function resumeEnabled(): boolean {
		const config = loadConfig();
		return !!config && config.resumeAfterLimit !== false;
	}

	function canResume(stalled: StalledLimit): boolean {
		// Identity includes the episode's start time; fresh live marks always beat restore epochs.
		return stalledLimit === stalled && stalled.ctx.isIdle() && !isLimited(stalled.ref);
	}

	async function resumeStalled(): Promise<void> {
		const stalled = stalledLimit;
		if (!stalled || checkingRecovery) return;
		if (!resumeEnabled()) { clearStall(); return; }
		if (!canResume(stalled)) return;
		checkingRecovery = true;
		try {
			await checkRestore(stalled.ctx);
			if (!canResume(stalled)) return;
			await preempt(stalled.ctx);
			// Input/shutdown may have invalidated this episode while model restoration was awaiting pi.
			if (!canResume(stalled)) return;
			clearStall(); // Consume before sending: callbacks and subsequent file events cannot resume it twice.
			pi.sendUserMessage(`Provider limits have lifted (${stalled.provider}). Continue where you stopped.`);
		} finally {
			checkingRecovery = false;
		}
	}

	/** Switch to `ref`, keeping the current thinking level. Our own switches run one at a time so each model_select can be matched to its switch. */
	function switchTo(ctx: ExtensionContext, ref: string, pending?: { ref: string; reason: string }): Promise<string | undefined> {
		const gen = selectionGen; // a manual pick after this point cancels the switch
		const run = switchChain.then(() => performSwitch(ctx, ref, gen, pending));
		switchChain = run.catch(() => undefined);
		return run;
	}

	async function performSwitch(ctx: ExtensionContext, ref: string, gen: number, pending?: { ref: string; reason: string }): Promise<string | undefined> {
		const { provider, id } = splitRef(ref);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) return `model ${ref} not found`;
		if (gen !== selectionGen) return SUPERSEDED;
		const level = pi.getThinkingLevel();
		inFlight = { ref, seen: false };
		pendingOriginal = pending;
		publishState();
		try {
			if (!(await pi.setModel(model))) return `no credentials for ${provider}`;
			if (gen !== selectionGen) {
				await reselectManual(ctx);
				return SUPERSEDED;
			}
			pi.setThinkingLevel(level);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			inFlight = undefined;
			pendingOriginal = undefined;
			publishState();
		}
		return undefined;
	}

	/** The user picked a model while our switch was in flight: put their model back (our own select is not a new manual pick). */
	async function reselectManual(ctx: ExtensionContext): Promise<void> {
		const gen = selectionGen;
		const { provider, id } = splitRef(manualRef ?? "");
		const model = manualRef ? ctx.modelRegistry.find(provider, id) : undefined;
		if (!model || !manualRef) return;
		inFlight = { ref: manualRef, seen: false };
		try {
			await pi.setModel(model);
			if (gen !== selectionGen) await reselectManual(ctx);
		} catch (error) {
			notify(ctx, `provider-fallback: could not reselect your model: ${String(error)}`, "warning");
		}
	}

	/** True (once) for the model_select our in-flight switch causes. */
	function isOwnSelect(model: { provider: string; id: string }): boolean {
		if (!inFlight || inFlight.seen || inFlight.ref !== refOf(model)) return false;
		inFlight.seen = true;
		return true;
	}

	/** The user picked `ref`: bump the generation, pin it and drop the marks that block it (main sessions only; subagents never touch shared marks). */
	function adoptManualSelection(ref: string): void {
		selectionGen++;
		manualRef = ref;
		try {
			updateMarks(statePath(), (raw) => clearForSelection(raw, ref, classify));
		} catch (error) {
			console.error("provider-fallback: clearing limit marks failed:", error);
		}
		pi.appendEntry<OriginalEntryData>(ORIGINAL_ENTRY, { originalRef: null, manualRef: ref, at: Date.now() });
		renderStatus();
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

	/** Switch back to the remembered original (expiry, or an operator request). True when it moved the session. */
	async function restoreOriginalModel(ctx: ExtensionContext, config: FallbackConfig, current: string, requested: boolean): Promise<boolean> {
		if (originalRef && originalRef !== current && originalDestination !== current) {
			// Stale record (e.g. restored from an entry after a /model change on another branch): never override the active model.
			forgetOriginal(ctx);
		}
		if (!originalRef || originalRef === current) return false;
		const pin = pinFor(config);
		if (pin && splitRef(originalRef).provider !== pin) {
			// A pinned session never goes back to another provider, even one it started on.
			forgetOriginal(ctx);
			return false;
		}
		if (!restoreEnabled(config, requested)) {
			restoreNote = "restoreWhenExpired is disabled";
			publishState();
			return false;
		}
		if (limitedUntil(originalRef) !== undefined) return false;
		const failure = await switchTo(ctx, originalRef);
		if (!failure) {
			notify(ctx, `provider-fallback: ${splitRef(originalRef).provider} ${restoreReason(requested)}; back on ${originalRef}.`, "info");
			forgetOriginal(ctx);
			return true;
		}
		restoreNote = `${originalRef}: ${failure}`;
		publishState();
		return false;
	}

	function recordHeadlessSwitch(ctx: ExtensionContext, data: { text: string; from: string; to: string; until: number }): void {
		if (!ctx.hasUI) pi.appendEntry(CUSTOM_TYPE, data);
	}

	/** Pre-emptive switch away from a marked provider, or back once the mark has expired. */
	async function preempt(ctx: ExtensionContext, requested = false): Promise<void> {
		const config = loadConfig();
		const current = refOf(ctx.model);
		if (!config || !current) return;

		if (await restoreOriginalModel(ctx, config, current, requested)) return;

		if (manualRef && manualRef === current) return; // the user's own choice is never pre-empted
		const currentProvider = splitRef(current).provider;
		const until = limitedUntil(current);
		if (until === undefined) return;
		const { target } = selectFallback(config, current, originalRef, isLimited, pinFor(config));
		if (!target) return; // no equivalent, every candidate limited, or pinned: nothing to gain
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
		rememberOriginal(ctx, { ref: originalRef ?? current, reason, destination: target, until });
		const text = `provider-fallback: ${currentProvider} limited (${formatUntil(until)} left); using ${target} instead of ${current} (${allowance}).`;
		recordHeadlessSwitch(ctx, { text, from: current, to: target, until });
		notify(ctx, text, "warning");
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
				notify(ctx, "Usage: /provider-restore [provider] [--all]  (shell: provider-restore [provider] [--all-sessions])", "warning");
				return;
			}
			const { provider, broadcast } = parsed;
			try {
				clearLimits(provider, broadcast);
			} catch (error) {
				notify(ctx, `provider-fallback: limits NOT cleared: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			const affectsOriginal = !provider || splitRef(originalRef ?? "").provider === provider;
			if (affectsOriginal) await preempt(ctx, true);
			notify(ctx, `provider-fallback: cleared ${provider ?? "all provider"} limits${broadcast ? "; restore broadcast sent" : ""}.`, "info");
		},
	});

	pi.on("turn_start", async (_event, ctx) => {
		request = { at: Date.now(), gen: selectionGen };
		await checkRestore(ctx);
	});

	/** A reload / context reset loses the in-memory originalRef and pin: take them from the latest persisted entries. */
	function loadPersisted(ctx: ExtensionContext): void {
		try {
			const branch = ctx.sessionManager.getBranch();
			const restored = restoreOriginal(branch);
			originalRef = restored?.originalRef;
			originalReason = restored?.reason;
			originalDestination = restored?.destination;
			originalUntil = restored?.until;
			const pin = restoreManualPin(branch);
			manualRef = pin && pin === refOf(ctx.model) ? pin : undefined;
		} catch {
			// entries unavailable: behave as before
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		clearStall();
		fallbacksThisPrompt = 0;
		pendingContinue = false;
		isMain = ctx.hasUI;
		originalRef = undefined;
		originalReason = undefined;
		originalDestination = undefined;
		originalUntil = undefined;
		manualRef = undefined;
		restoreNote = undefined;
		uiCtx = ctx.hasUI ? ctx : undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = undefined;
		}
		lineage = sessionLineage(ctx.sessionManager as LineageSource);
		// The process root seeds it: the UI session, or the first session of a headless (-p/RPC) process.
		if (isMain || !processMainLineage().length) setProcessMainLineage(lineage);
		if (isMain) loadPersisted(ctx);
		publishState();
		await preempt(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearStall();
		originalRef = undefined;
		renderStatus(); // clears the widget
		uiCtx = undefined;
		if (isMain) publishFallbackState(undefined);
		isMain = false;
	});

	pi.on("input", async () => { clearStall(); });

	pi.on("before_agent_start", async (_event, ctx) => {
		clearStall();
		fallbacksThisPrompt = 0;
		pendingContinue = false;
		await checkRestore(ctx);
		await preempt(ctx);
		renderStatus(); // surfaces the stale-extension hint
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore" || isOwnSelect(event.model)) return;
		forgetOriginal(ctx);
		if (ctx.hasUI) adoptManualSelection(refOf(event.model) ?? "");
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (event.status === 429) lastLimitHeaders = { at: Date.now(), provider: ctx.model?.provider, headers: event.headers };
	});

	// A new model request is starting (pi's retry or our continuation): the pending one is consumed.
	pi.on("agent_start", async () => {
		pendingContinue = false;
	});

	pi.on("agent_settled", async () => {
		if (stalledLimit) recoveryWatch.schedule();
	});

	/** A successful request proves its model works: expire the marks that predate the request (never a fresher one). */
	function recordSuccess(message: { provider: string; model: string; stopReason?: string }, startedAt: number | undefined): void {
		if (startedAt === undefined || !["stop", "toolUse", "length"].includes(message.stopReason ?? "")) return;
		const ref = `${message.provider}/${message.model}`;
		const before = readMarks(statePath());
		if (Object.keys(clearOnSuccess(before, ref, startedAt, classify)).length === Object.keys(before).length) return;
		try {
			updateMarks(statePath(), (raw) => clearOnSuccess(raw, ref, startedAt, classify));
		} catch (error) {
			console.error("provider-fallback: early expiry skipped:", error instanceof Error ? error.message : error);
		}
	}

	/** Absolute expiry of a new mark: unavailable uses the short mark, a limit the reset in the error text, then the response headers, then the default. */
	function limitExpiry(config: FallbackConfig, kind: "limit" | "unavailable", message: { provider: string; errorMessage?: string }, now: number): number {
		const headers =
			lastLimitHeaders && now - lastLimitHeaders.at < HEADER_MAX_AGE_MS && lastLimitHeaders.provider === message.provider
				? resetFromHeaders(lastLimitHeaders.headers, now)
				: undefined;
		lastLimitHeaders = undefined;
		const fallback = kind === "unavailable" ? now + (config.unavailableMinutes ?? 10) * 60_000 : (resetFromText(message.errorMessage ?? "", now) ?? headers ?? now + (config.defaultLimitMinutes ?? 60) * 60_000);
		return Math.max(now + MIN_LIMIT_MS, fallback);
	}

	pi.on("turn_end", async (event, ctx) => {
		clearStall();
		const started = request;
		request = undefined;
		const message = event.message;
		if (message.role === "assistant") recordSuccess(message, started?.at);
		if (message.role !== "assistant" || message.stopReason !== "error" || !message.errorMessage) return;
		const config = loadConfig();
		const kind = config && classifyError(config, message.provider, message.errorMessage);
		if (!config || !kind) return;
		const what = kind === "limit" ? "hit a usage/rate limit" : "is unavailable";

		const now = Date.now();
		const until = limitExpiry(config, kind, message, now);
		const from = `${message.provider}/${message.model}`;
		const scope = kind === "unavailable" ? "account" : limitScope(config, message.provider, message.errorMessage);
		markLimited(markKeyFor(scope, message.provider, from), { until, since: now, model: from, reason: message.errorMessage.slice(0, 200), scope });
		if (started && started.gen < selectionGen) {
			// The request began before the user's latest model choice: record the mark, but do not move the chosen model.
			notify(ctx, `provider-fallback: ${from} hit a limit in a request started before your model selection; not switching.`, "info");
			return;
		}
		recordStall({ ctx, provider: message.provider, ref: from, since: now }, config, kind);

		const note = (text: string, type: "info" | "warning" | "error") => {
			notify(ctx, text, type);
			return fallbackNote(text, from, event.entries);
		};

		const pin = pinFor(config);
		const selection = selectFallback(config, from, originalRef, isLimited, pin);
		const target = selection.target;
		if (!target && !selection.blocked.length && pin) {
			return note(`provider-fallback: ${from} ${what} (${formatUntil(until)}); this session is pinned to ${pin} (providerPins), so it waits for the limit to clear instead of switching provider.`, "warning");
		}
		if (!target && !selection.blocked.length) return note(`provider-fallback: ${from} ${what} and has no configured equivalent.`, "error");
		if (!target && selection.chain) {
			const list = selection.blocked.map((ref) => `${ref} (${formatUntil(limitedUntil(ref) ?? now)})`).join(", ");
			return note(
				`provider-fallback: ${from} ${what} (${formatUntil(until)}) and every fallback is limited — ${list}. Not switching; stop and wait or change plans.`,
				"error",
			);
		}
		if (!target) {
			const targetProvider = splitRef(selection.blocked[0]).provider;
			const targetUntil = limitedUntil(selection.blocked[0]) ?? now;
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
		const reason = `${scope === "account" ? message.provider : from} ${kind === "limit" ? "limited" : "unavailable"} until ${untilClock(until)}`;
		const allowance = contextLimitLabel(ctx, config, target);
		const failure = await switchTo(ctx, target, { ref: originalRef ?? from, reason });
		if (failure) return note(`provider-fallback: ${from} hit a limit; switching to ${target} failed: ${failure}`, "error");

		fallbacksThisPrompt++;
		pendingContinue = true;
		rememberOriginal(ctx, { ref: originalRef ?? from, reason, destination: target, until });
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
