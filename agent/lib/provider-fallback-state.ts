/**
 * Shared, process-local view of what provider-fallback did to the main session, plus the
 * session-entry format used to survive a reload / context reset.
 * provider-fallback publishes; model-drift reads. Pure helpers, no pi imports.
 */
export const STATE_KEY = Symbol.for("pi-setup:provider-fallback");
export const ORIGINAL_ENTRY = "provider-fallback-original";

export interface FallbackPublished {
	/** The model provider-fallback moved the session away from. */
	originalRef?: string;
	/** Human reason, e.g. "anthropic limited until 14:05". */
	reason?: string;
	at?: number;
	/** Session the state belongs to (published state is process-global); readers ignore other sessions. */
	sessionId?: string;
	/** The model fallback switched to (persisted entries only). */
	destination?: string;
	/** True while provider-fallback itself is calling setModel (its model_select is not a user choice). */
	switching?: boolean;
	/** When the limit that moved the session expires. */
	until?: number;
	/** Why switching back is currently impossible (restore failed / disabled), if so. */
	restoreNote?: string;
}

const LISTENERS_KEY = Symbol.for("pi-setup:provider-fallback:listeners");
type Holder = { [STATE_KEY]?: FallbackPublished; [LISTENERS_KEY]?: Set<() => void> };

export function publishFallbackState(state: FallbackPublished | undefined, holder: object = globalThis): void {
	(holder as Holder)[STATE_KEY] = state;
	for (const listener of [...((holder as Holder)[LISTENERS_KEY] ?? [])]) {
		try {
			listener();
		} catch {
			// a listener must not break publishing
		}
	}
}

/** Called after every publish (state may be undefined). Returns an unsubscribe function. */
export function onFallbackState(listener: () => void, holder: object = globalThis): () => void {
	const set = ((holder as Holder)[LISTENERS_KEY] ??= new Set());
	set.add(listener);
	return () => set.delete(listener);
}

export function readFallbackState(holder: object = globalThis): FallbackPublished | undefined {
	return (holder as Holder)[STATE_KEY];
}

/** Data of the persisted entry; `originalRef: null` means "cleared". */
export interface OriginalEntryData {
	originalRef: string | null;
	destination?: string;
	reason?: string;
	at?: number;
	/** When the limit mark that caused the fallback expires (for the status widget). */
	until?: number;
	/** With `originalRef: null`: the model the user picked manually; fallback does not pre-empt it. */
	manualRef?: string;
}

/** Latest persisted originalRef in the given branch entries (undefined when none or cleared). */
export function restoreOriginal(entries: readonly unknown[]): FallbackPublished | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: Partial<OriginalEntryData> } | undefined;
		if (entry?.type !== "custom" || entry.customType !== ORIGINAL_ENTRY) continue;
		const ref = entry.data?.originalRef;
		if (typeof ref !== "string" || !ref) return undefined;
		return { originalRef: ref, until: typeof entry.data?.until === "number" ? entry.data.until : undefined, destination: typeof entry.data?.destination === "string" ? entry.data.destination : undefined, reason: typeof entry.data?.reason === "string" ? entry.data.reason : undefined, at: entry.data?.at };
	}
	return undefined;
}

/** The manual-selection pin in the latest persisted entry (an entry with `originalRef: null` and a `manualRef`), else undefined. */
export function restoreManualPin(entries: readonly unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: Partial<OriginalEntryData> } | undefined;
		if (entry?.type !== "custom" || entry.customType !== ORIGINAL_ENTRY) continue;
		const pin = entry.data?.manualRef;
		return entry.data?.originalRef === null && typeof pin === "string" && pin ? pin : undefined;
	}
	return undefined;
}
