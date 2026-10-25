/**
 * Provider limit marks (shared `.provider-limits.json`): scope rules, pure mutations, and the one locked
 * read-modify-write path every writer uses. No pi imports.
 *
 * Key scheme (flat, backward compatible): `"<provider>"` is an account-wide mark, `"<provider>/<id>"` a model mark.
 * Old files hold provider keys with a `model` and `reason`; they are reinterpreted on read, never rewritten.
 * `agent/bin/provider-restore` repeats the lock protocol of `withMarksLock` (it is a stdlib-only CLI): keep them in sync.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Scope = "account" | "model";
export interface MarkEntry {
	until: number;
	since: number;
	model?: string;
	reason?: string;
	scope?: Scope;
}
export type RawMarks = Record<string, MarkEntry>;
/** Decides whether an error text is account-wide or model-scoped for a provider. */
export type Classify = (provider: string, errorText: string) => Scope;
export interface Interpreted {
	key: string;
	provider: string;
	ref?: string;
	scope: Scope;
	until: number;
	since: number;
}

/** Unambiguous plan/quota exhaustion. Anthropic's `rate_limit_error` is per model class, so it is not listed. */
export const DEFAULT_ACCOUNT_WIDE = [/usage limit/i, /quota/i, /billing|credit balance|extra usage|upgrade your plan/i];
const PLAIN_RATE_LIMIT = /\b429\b|rate[_\s-]?limit/i;
const OUTAGE = /overloaded|unavailable|\b5\d\d\b|time(?:d)?[\s-]?out|capacity/i;

export function splitKey(key: string): { provider: string; id?: string } {
	const slash = key.indexOf("/");
	return slash < 0 ? { provider: key } : { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

function matchesAny(patterns: (string | RegExp)[] | undefined, text: string): boolean {
	return (patterns ?? []).some((source) => {
		try {
			return (typeof source === "string" ? new RegExp(source, "i") : source).test(text);
		} catch {
			return false;
		}
	});
}

/** "account" only for unambiguous plan/quota text (or the provider's configured patterns); otherwise the model. */
export function limitScope(config: { accountWidePatterns?: Record<string, string[]> }, provider: string, errorText: string): Scope {
	if (matchesAny(config.accountWidePatterns?.[provider], errorText)) return "account";
	return matchesAny(DEFAULT_ACCOUNT_WIDE, errorText) ? "account" : "model";
}

export const markKeyFor = (scope: Scope, provider: string, ref: string): string => (scope === "account" ? provider : ref);

/** A legacy entry narrows to its model only when the stored error is a plain rate limit (not an outage or quota). */
function isPlainModelRateLimit(provider: string, entry: MarkEntry, classify: Classify): boolean {
	const reason = entry.reason ?? "";
	const model = splitKey(entry.model ?? "");
	if (entry.scope || model.provider !== provider || !model.id) return false;
	return PLAIN_RATE_LIMIT.test(reason) && !OUTAGE.test(reason) && classify(provider, reason) === "model";
}

/** Legacy provider-wide entries narrow to their model only for a plain rate limit naming a model of that provider. */
export function interpret(key: string, entry: MarkEntry, classify: Classify): Interpreted {
	const base = { key, until: entry.until, since: entry.since ?? 0 };
	const { provider, id } = splitKey(key);
	if (id !== undefined) return { ...base, provider, ref: key, scope: "model" };
	if (isPlainModelRateLimit(provider, entry, classify)) return { ...base, provider, ref: entry.model, scope: "model" };
	return { ...base, provider, scope: "account" };
}

const blocks = (mark: Interpreted, ref: string): boolean =>
	mark.scope === "account" ? mark.provider === splitKey(ref).provider : mark.ref === ref;

function entriesOf(raw: RawMarks): [string, MarkEntry][] {
	return Object.entries(raw).filter(([, entry]) => entry && typeof entry.until === "number");
}

export function liveMarks(raw: RawMarks, now: number): RawMarks {
	return Object.fromEntries(entriesOf(raw).filter(([, entry]) => entry.until > now));
}

/** The live mark with the latest `until` that blocks `ref` (its provider's account mark or its own model mark). */
export function blockingMark(raw: RawMarks, ref: string, now: number, classify: Classify): Interpreted | undefined {
	const blocking = entriesOf(liveMarks(raw, now))
		.map(([key, entry]) => interpret(key, entry, classify))
		.filter((mark) => blocks(mark, ref));
	return blocking.sort((x, y) => y.until - x.until)[0];
}

/** Add a mark (expired entries pruned, the later `until` kept). */
export function merge(raw: RawMarks, key: string, entry: MarkEntry, now: number): RawMarks {
	const next = liveMarks(raw, now);
	const previous = next[key];
	next[key] = previous && previous.until > entry.until ? { ...entry, until: previous.until } : entry;
	return next;
}

export function clearProvider(raw: RawMarks, provider: string): RawMarks {
	return Object.fromEntries(Object.entries(raw).filter(([key]) => splitKey(key).provider !== provider));
}

function clearBlocking(raw: RawMarks, ref: string, classify: Classify, keep: (mark: Interpreted) => boolean): RawMarks {
	return Object.fromEntries(
		Object.entries(raw).filter(([key, entry]) => !(entry && typeof entry.until === "number" && blocks(interpret(key, entry, classify), ref) && !keep(interpret(key, entry, classify)))),
	);
}

/** A manual selection: drop the marks that block `ref` (account, its own, a legacy one naming it). */
export const clearForSelection = (raw: RawMarks, ref: string, classify: Classify): RawMarks => clearBlocking(raw, ref, classify, () => false);

/** A proven success of a request that started at `startedAt`: drop blocking marks that were already there. */
export const clearOnSuccess = (raw: RawMarks, ref: string, startedAt: number, classify: Classify): RawMarks =>
	clearBlocking(raw, ref, classify, (mark) => mark.since >= startedAt);

export function readMarks(path: string): RawMarks {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RawMarks) : {};
	} catch {
		return {};
	}
}

export function writeMarks(path: string, raw: RawMarks): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

const LOCK_STALE_MS = 10_000;
const LOCK_ATTEMPTS = 400;
const LOCK_WAIT_MS = 5;

/** Exclusive O_EXCL lock file (`<path>.lock`); a lock older than 10 s is taken over, and after ~2 s of waiting we proceed unlocked. */
export function withMarksLock<T>(path: string, fn: () => T): T {
	const lock = `${path}.lock`;
	mkdirSync(dirname(path), { recursive: true });
	let held = false;
	for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt++) {
		try {
			closeSync(openSync(lock, "wx"));
			held = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
				else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
			} catch {
				// the holder released it between our calls: retry
			}
		}
	}
	try {
		return fn();
	} finally {
		if (held) {
			try {
				unlinkSync(lock);
			} catch {
				// already gone
			}
		}
	}
}

/** The single read-modify-write path: lock, read, mutate, write atomically (skipped when nothing changed). */
export function updateMarks(path: string, mutate: (raw: RawMarks) => RawMarks): RawMarks {
	return withMarksLock(path, () => {
		const before = readMarks(path);
		const after = mutate(before);
		if (JSON.stringify(after) !== JSON.stringify(before)) writeMarks(path, after);
		return after;
	});
}
