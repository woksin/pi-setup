/** Value-free attribution from runtime branch entries; no I/O or assistant content. */
export const PROVENANCE_KEY = "runtimeProvenance";
export const PROVENANCE_SOURCE = "model-provenance/v1";
const REASON_MAX_CHARS = 160;

type Entry = Record<string, unknown>;
type Switch = { at?: string; from: string; to: string; when: string; reason?: string };
function object(value: unknown): Entry {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Entry : {};
}
function ref(provider: unknown, model: unknown): string | undefined {
	return typeof provider === "string" && provider.length > 0 && typeof model === "string" && model.length > 0
		? `${provider}/${model}` : undefined;
}
function timestamp(entry: Entry): string | undefined {
	return typeof entry.timestamp === "string" ? entry.timestamp : undefined;
}
function assistant(entry: Entry): Entry | undefined {
	const message = object(entry.message);
	return entry.type === "message" && message.role === "assistant" ? message : undefined;
}
function fallbackReason(entry: Entry, to: string): string | undefined {
	if (entry.type !== "custom" || entry.customType !== "provider-fallback") return undefined;
	const data = object(entry.data);
	return data.to === to && typeof data.text === "string" ? data.text.slice(0, REASON_MAX_CHARS) : undefined;
}
function reasonAt(entries: Entry[], index: number, to: string): string | undefined {
	const before = fallbackReason(entries[index - 1] ?? {}, to);
	if (before !== undefined) return before;
	for (let i = index + 1; i < entries.length; i++) {
		if (entries[i].type === "model_change") break;
		const after = fallbackReason(entries[i], to);
		if (after !== undefined) return after;
	}
	return undefined;
}
function history(entries: Entry[]) {
	let initial: string | undefined;
	let previous: string | undefined;
	let lastAssistant: Entry | undefined;
	const switches: Switch[] = [];
	entries.forEach((entry, index) => {
		lastAssistant = assistant(entry) ?? lastAssistant;
		if (entry.type !== "model_change") return;
		const to = ref(entry.provider, entry.modelId);
		if (!to) return;
		initial ??= to;
		if (previous && previous !== to) {
			const when = !lastAssistant ? "before-first-response"
				: lastAssistant.stopReason === "error" ? "after-request-failure" : "mid-review";
			switches.push({ at: timestamp(entry), from: previous, to, when, reason: reasonAt(entries, index, to) });
		}
		previous = to;
	});
	return { initial, switches };
}

function countsFor(refs: (string | undefined)[]) {
	const counts = new Map<string, number>();
	for (const model of refs) {
		if (model) counts.set(model, (counts.get(model) ?? 0) + 1);
	}
	return Object.fromEntries(counts);
}

export function buildProvenance(rawEntries: unknown[], { session }: { session?: string } = {}) {
	const entries = rawEntries.map(object);
	const messages = entries.filter(entry => assistant(entry));
	const refs = messages.map(entry => {
		const message = assistant(entry)!;
		return ref(message.provider, message.model);
	});
	const names = entries.filter(entry => entry.type === "session_info" && typeof entry.name === "string");
	return {
		source: PROVENANCE_SOURCE, session, agent: names.at(-1)?.name,
		...history(entries), models: [...new Set(refs.filter((model): model is string => model !== undefined))], modelCounts: countsFor(refs),
		assistants: messages.length, errors: messages.filter(entry => assistant(entry)!.stopReason === "error").length,
		firstAt: timestamp(messages[0] ?? {}), lastAt: timestamp(messages.at(-1) ?? {}),
		...(refs.includes(undefined) ? { unavailable: "assistant model record missing" } : {}),
	};
}
