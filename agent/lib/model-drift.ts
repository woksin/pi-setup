/**
 * model-drift core: expected main-session model, drift evaluation, one-message-per-pair bookkeeping.
 * The extension (extensions/model-drift.ts) wires this to pi events and UI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FallbackPublished } from "./provider-fallback-state.ts";

export interface Expected {
	ref: string;
	/** "profile <name>" or "settings.json default". */
	from: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const isRef = (value: unknown): value is string => typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);

/** profiles/<ACTIVE>/profile.json `mainModel`, else settings.json defaultProvider/defaultModel; undefined when unknown. */
export function expectedModel(agentDir: string): Expected | undefined {
	try {
		const active = readFileSync(join(agentDir, "profiles", "ACTIVE"), "utf8").trim();
		if (active && !/[\\/]/.test(active)) {
			const main = readJson(join(agentDir, "profiles", active, "profile.json"))?.mainModel;
			if (isRef(main)) return { ref: main, from: `profile ${active}` };
		}
	} catch {
		// no active profile: fall through to settings
	}
	const settings = readJson(join(agentDir, "settings.json"));
	const provider = settings?.defaultProvider;
	const model = settings?.defaultModel;
	if (typeof provider === "string" && typeof model === "string" && provider && model) {
		return { ref: `${provider}/${model}`, from: "settings.json default" };
	}
	return undefined;
}

export type DriftSource = "user" | "provider-fallback" | "default";

export interface Drift {
	current: string;
	expected: string;
	expectedFrom: string;
	source: DriftSource;
	/** e.g. "via user /model". */
	sourceText: string;
	reason: string;
}

export interface Evaluation {
	/** Status line text, undefined clears it. */
	status?: string;
	/** Visible message, at most once per (current, expected) pair. */
	message?: string;
	/** Pair key to persist as notified (set together with `message`). */
	notifiedPair?: string;
	/** Entry data to log when the drift state changed. */
	log?: Record<string, unknown>;
}

export class DriftTracker {
	private lastSelect: "user" | "provider-fallback" | "restore" | undefined;
	private readonly notified = new Set<string>();
	private lastKey: string | undefined;

	/** Record a model_select. `switching` = provider-fallback is the caller. */
	onModelSelect(source: string, switching: boolean): void {
		if (switching) this.lastSelect = "provider-fallback";
		else if (source === "restore") this.lastSelect = "restore";
		else this.lastSelect = "user";
	}

	/** Pairs already announced (restored from persisted entries after a reload). */
	markNotified(pairs: Iterable<string>): void {
		for (const pair of pairs) this.notified.add(pair);
	}

	/** New session (reload / reset): forget per-session notices. */
	reset(): void {
		this.lastSelect = undefined;
		this.notified.clear();
		this.lastKey = undefined;
	}

	evaluate(current: string | undefined, expected: Expected | undefined, fallback: FallbackPublished | undefined): Evaluation {
		const matching = !current || !expected || current === expected.ref;
		if (matching) {
			const wasDrifted = this.lastKey !== undefined;
			this.lastKey = undefined;
			return wasDrifted ? { status: undefined, log: { drift: false, current, expected: expected?.ref } } : { status: undefined };
		}
		const drift = describe(current, expected, fallback, this.lastSelect);
		const status =
			`model: ${current} (profile: ${expected.ref}, via ${drift.sourceText})` + (fallback?.restoreNote && drift.source === "provider-fallback" ? ` — cannot switch back: ${fallback.restoreNote}` : "");
		const key = `${current}|${expected.ref}|${drift.source}`;
		const out: Evaluation = { status };
		if (key !== this.lastKey) {
			this.lastKey = key;
			out.log = { drift: true, current, expected: expected.ref, expectedFrom: expected.from, source: drift.source, reason: drift.reason };
		}
		const pair = `${current}|${expected.ref}`;
		if (!this.notified.has(pair)) {
			this.notified.add(pair);
			out.notifiedPair = pair;
			out.message = `Running on ${current}, ${expected.from} says ${expected.ref} (${drift.reason}); \`/model ${expected.ref}\` to switch back.`;
		}
		return out;
	}
}

function describe(current: string, expected: Expected, fallback: FallbackPublished | undefined, lastSelect: string | undefined): Drift {
	const base = { current, expected: expected.ref, expectedFrom: expected.from };
	if (lastSelect === "user") {
		return { ...base, source: "user", sourceText: "user /model", reason: "you changed the model with /model" };
	}
	if (fallback?.originalRef && fallback.originalRef !== current) {
		const why = fallback.reason ?? "limit or outage";
		return { ...base, source: "provider-fallback", sourceText: "provider-fallback", reason: `provider-fallback moved this session: ${why}` };
	}
	return { ...base, source: "default", sourceText: "profile/default", reason: "session started or was restored on a different model than the profile default" };
}
