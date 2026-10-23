/** Item model, validation, status transitions and ownership. No I/O. */

export const KINDS = ["question", "decision", "approval", "fyi"] as const;
export const STATUSES = ["open", "answered", "decided", "deferred", "withdrawn", "superseded", "closed"] as const;
export const URGENCIES = ["high", "normal", "low"] as const;
export const HISTORY_TYPES = [
	"created", "edited", "comment", "answered", "decided", "deferred", "reopened",
	"withdrawn", "superseded", "closed", "linked",
] as const;

export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Urgency = (typeof URGENCIES)[number];
export type HistoryType = (typeof HISTORY_TYPES)[number];

export const MAX_TITLE = 120;
export const MAX_BODY = 4000;
export const MAX_SOURCE = 2000;

export interface Option { key: string; text: string }
export interface Actor { kind: "user" | "agent"; sessionId: string; lane?: string; name?: string }
export interface HistoryEntry {
	seq: number;
	at: string;
	actor: Actor;
	type: HistoryType;
	text?: string;
	fields?: Record<string, unknown>;
}
export interface Answer {
	text: string;
	option?: string;
	by: string;
	via: "command" | "quote";
	source?: string;
	sessionId: string;
	at: string;
}
export interface Asker { sessionId: string; lane?: string; cwd: string; repo: string | null; pid: number }

export interface Item {
	id: string;
	rev: number;
	kind: Kind;
	title: string;
	body: string;
	options: Option[];
	recommended?: string;
	urgency: Urgency;
	blocking: string;
	links: string[];
	tags: string[];
	repo: string | null;
	project?: string;
	asker: Asker;
	cc: string[];
	for?: string[];
	status: Status;
	deferredUntil?: string;
	supersededBy?: string;
	related: string[];
	duplicateOf?: string;
	answer?: Answer;
	history: HistoryEntry[];
	createdAt: string;
	updatedAt: string;
}

export interface Draft {
	kind: Kind;
	title: string;
	body: string;
	options: Option[];
	recommended?: string;
	urgency: Urgency;
	blocking: string;
	links: string[];
	tags: string[];
	cc: string[];
	for?: string[];
	global: boolean;
	project?: string;
	distinctFrom: string[];
}

export const ID_RE = /^Q-\d+$/;

/** "42", "Q-42" and "q42" all name Q-42. */
export function parseId(raw: unknown): string | null {
	const m = /^q?-?(\d+)$/i.exec(String(raw ?? "").trim());
	return m ? `Q-${Number(m[1])}` : null;
}

export function idNumber(id: string): number {
	return Number(id.slice(2));
}

function str(v: unknown, name: string, max: number, required = false): string {
	if (v === undefined || v === null) {
		if (required) throw new Error(`${name} is required`);
		return "";
	}
	if (typeof v !== "string") throw new Error(`${name} must be a string`);
	const s = v.trim();
	if (required && !s) throw new Error(`${name} is required`);
	if (s.length > max) throw new Error(`${name} is too long (${s.length} characters, at most ${max})`);
	return s;
}

function strList(v: unknown, name: string): string[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.some(x => typeof x !== "string" || !x.trim())) throw new Error(`${name} must be a list of non-empty strings`);
	return [...new Set((v as string[]).map(x => x.trim()))];
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[], fallback?: T): T {
	if (v === undefined || v === null || v === "") {
		if (fallback) return fallback;
		throw new Error(`${name} is required (${allowed.join(" | ")})`);
	}
	if (!allowed.includes(v as T)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
	return v as T;
}

export function validateOptions(v: unknown): Option[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v)) throw new Error("options must be a list of {key, text}");
	const seen = new Set<string>();
	return v.map(o => {
		const key = str(o?.key, "option key", 20, true);
		const text = str(o?.text, "option text", 300, true);
		if (seen.has(key)) throw new Error(`duplicate option key: ${key}`);
		seen.add(key);
		return { key, text };
	});
}

function forRecipients(input: unknown): string[] | undefined {
	const recipients = strList(input, "for");
	if (recipients.length > 5) throw new Error("for accepts at most 5 recipients");
	return recipients.length ? recipients : undefined;
}

export function validateDraft(input: Record<string, unknown>): Draft {
	const options = validateOptions(input.options);
	const recommended = input.recommended === undefined ? undefined : str(input.recommended, "recommended", 20);
	if (recommended && !options.some(o => o.key === recommended)) throw new Error(`recommended "${recommended}" is not one of the option keys`);
	return {
		kind: oneOf(input.kind, "kind", KINDS),
		title: str(input.title, "title", MAX_TITLE, true),
		body: str(input.body, "body", MAX_BODY),
		options,
		recommended: recommended || undefined,
		urgency: oneOf(input.urgency, "urgency", URGENCIES, "normal"),
		blocking: str(input.blocking, "blocking", 300),
		links: strList(input.links, "links"),
		tags: strList(input.tags, "tags"),
		cc: strList(input.cc, "cc"),
		for: forRecipients(input.for),
		global: input.global === true,
		project: str(input.project, "project", 60) || undefined,
		distinctFrom: strList(input.distinctFrom, "distinctFrom").map(x => parseId(x) ?? x),
	};
}

/** Cheap structural check applied before every write. */
export function validateItem(item: Item): void {
	if (!ID_RE.test(item.id)) throw new Error(`invalid item id: ${item.id}`);
	if (!KINDS.includes(item.kind)) throw new Error(`invalid kind: ${item.kind}`);
	if (!STATUSES.includes(item.status)) throw new Error(`invalid status: ${item.status}`);
	if (!URGENCIES.includes(item.urgency)) throw new Error(`invalid urgency: ${item.urgency}`);
	if (!item.title || item.title.length > MAX_TITLE) throw new Error(`title must be 1-${MAX_TITLE} characters`);
	if (item.body.length > MAX_BODY) throw new Error(`body must be at most ${MAX_BODY} characters`);
	if (!Array.isArray(item.history)) throw new Error("history must be a list");
}

const TRANSITIONS: Record<Status, Status[]> = {
	open: ["answered", "decided", "deferred", "withdrawn", "superseded", "closed"],
	deferred: ["open", "answered", "decided", "withdrawn", "superseded", "closed"],
	answered: ["open", "decided", "superseded", "closed"],
	decided: ["open", "superseded", "closed"],
	withdrawn: ["open"],
	superseded: ["open"],
	closed: ["open"],
};

export function canTransition(from: Status, to: Status): boolean {
	return TRANSITIONS[from].includes(to);
}

export function assertTransition(item: Item, to: Status): void {
	if (!canTransition(item.status, to)) throw new Error(`${item.id} is ${item.status}; it cannot become ${to}`);
}

/** Own means the same session, or the same lane, as the asker. */
export function isOwn(item: Item, who: { sessionId: string; lane?: string }): boolean {
	if (item.asker.sessionId === who.sessionId) return true;
	return !!who.lane && item.asker.lane === who.lane;
}

/** Open, or deferred with the date reached (a deferral without a date never comes due). */
export function isActive(item: Item, now: number): boolean {
	if (item.status === "open") return true;
	if (item.status !== "deferred" || !item.deferredUntil) return false;
	return Date.parse(item.deferredUntil) <= now;
}

export function addHistory(
	item: Item, actor: Actor, type: HistoryType, at: string, text?: string, fields?: Record<string, unknown>,
): HistoryEntry {
	const entry: HistoryEntry = { seq: (item.history.at(-1)?.seq ?? 0) + 1, at, actor, type };
	if (text !== undefined) entry.text = text;
	if (fields) entry.fields = fields;
	item.history.push(entry);
	return entry;
}

/** A history entry is delivered back to the asker when the user did it, or it is an answer or decision. */
export function isDeliverable(h: HistoryEntry): boolean {
	return h.actor.kind === "user" || h.type === "answered" || h.type === "decided";
}
