/** Item operations shared by the tool, the user commands and the CLI. Policy (who may call what) lives with the callers. */
import { candidates, uncovered, type Scored } from "./dedup.ts";
import {
	addHistory, assertTransition, MAX_SOURCE, parseId, validateOptions,
	type Actor, type Asker, type Draft, type Item, type Option, type Status,
} from "./model.ts";
import { createItem, listItems, mutateItem, readItem, type CreateHooks } from "./store.ts";

export interface AskResult {
	item: Item;
	nearMisses: Scored[];
}
export interface Refusal { candidates: Scored[]; missing: string[]; nearMisses: Scored[] }

const iso = (now: number) => new Date(now).toISOString();

/** Keep routing metadata absent on legacy items, rather than writing an empty recipient list. */
function routingFields(draft: Draft): Pick<Item, "for"> {
	return draft.for?.length ? { for: draft.for } : {};
}

export function ask(
	home: string, draft: Draft, asker: Asker, now = Date.now(), hooks: CreateHooks = {},
): { ok: AskResult } | { refused: Refusal } {
	const repo = draft.global ? null : asker.repo;
	let near: Scored[] = [];
	const out = createItem<Refusal>(home, existing => {
		const found = candidates(existing, { title: draft.title, body: draft.body, links: draft.links, repo }, now);
		near = found.nearMisses;
		const missing = uncovered(found.candidates, draft.distinctFrom);
		if (missing.length) return { refuse: { candidates: found.candidates, missing, nearMisses: found.nearMisses } };
		return {
			build: id => {
				const at = iso(now);
				const item: Item = {
					id, rev: 1, kind: draft.kind, title: draft.title, body: draft.body, options: draft.options,
					urgency: draft.urgency, blocking: draft.blocking, links: draft.links, tags: draft.tags, repo,
					asker, cc: draft.cc.filter(c => c !== asker.sessionId && c !== asker.lane), ...routingFields(draft),
					status: "open", related: found.candidates.map(c => c.item.id), history: [],
					createdAt: at, updatedAt: at,
				};
				if (draft.recommended) item.recommended = draft.recommended;
				if (draft.project) item.project = draft.project;
				addHistory(item, { kind: "agent", sessionId: asker.sessionId, lane: asker.lane }, "created", at,
					found.candidates.length ? `distinct from ${found.candidates.map(c => c.item.id).join(", ")}` : undefined);
				return item;
			},
		};
	}, hooks);
	if (!("item" in out)) return { refused: out.refused };
	return { ok: { item: out.item, nearMisses: near } };
}

export function getItem(home: string, rawId: string): Item {
	const id = parseId(rawId);
	if (!id) throw new Error(`"${rawId}" is not an item id (use Q-42, q42 or 42)`);
	const item = readItem(home, id);
	if (!item) throw new Error(`${id} does not exist`);
	return item;
}

const idOf = (raw: string) => {
	const id = parseId(raw);
	if (!id) throw new Error(`"${raw}" is not an item id (use Q-42, q42 or 42)`);
	return id;
};

function settle(home: string, rawId: string, actor: Actor, to: Status, type: "answered" | "decided", now: number, answer: {
	text: string; option?: string; by: string; via: "command" | "quote"; source?: string;
}): Item {
	return mutateItem(home, idOf(rawId), item => {
		if (item.status !== "open" && item.status !== "deferred") throw new Error(`${item.id} is ${item.status}; reopen it first to change the answer`);
		assertTransition(item, to);
		if (answer.option !== undefined && !item.options.some(o => o.key === answer.option)) {
			throw new Error(`${item.id} has no option "${answer.option}" (options: ${item.options.map(o => o.key).join(", ") || "none"})`);
		}
		const at = iso(now);
		item.status = to;
		delete item.deferredUntil;
		item.answer = { text: answer.text, by: answer.by, via: answer.via, sessionId: actor.sessionId, at };
		if (answer.option !== undefined) item.answer.option = answer.option;
		if (answer.source !== undefined) item.answer.source = answer.source.slice(0, MAX_SOURCE);
		addHistory(item, actor, type, at, answer.text, answer.option !== undefined ? { option: answer.option } : undefined);
	}, new Date(now));
}

export const answerItem = (home: string, id: string, actor: Actor, a: { text: string; by: string; via: "command" | "quote"; source?: string; option?: string }, now = Date.now()) =>
	settle(home, id, actor, a.option !== undefined ? "decided" : "answered", a.option !== undefined ? "decided" : "answered", now, a);

/** Pick an option by key or 1-based number and record the decision. */
export function decideItem(home: string, id: string, actor: Actor, by: string, choice: string, rationale: string, now = Date.now()): Item {
	const item = getItem(home, id);
	const opt: Option | undefined = item.options.find(o => o.key === choice) ?? (/^\d+$/.test(choice) ? item.options[Number(choice) - 1] : undefined);
	if (!opt) throw new Error(`${item.id} has no option "${choice}" (options: ${item.options.map((o, i) => `${i + 1}=${o.key}`).join(", ") || "none"})`);
	return settle(home, id, actor, "decided", "decided", now, { text: rationale || opt.text, option: opt.key, by, via: "command" });
}

export function deferItem(home: string, id: string, actor: Actor, until: string | undefined, reason: string | undefined, now = Date.now()): Item {
	return mutateItem(home, idOf(id), item => {
		assertTransition(item, "deferred");
		item.status = "deferred";
		if (until) item.deferredUntil = until;
		else delete item.deferredUntil;
		addHistory(item, actor, "deferred", iso(now), reason, until ? { until } : undefined);
	}, new Date(now));
}

export function reopenItem(home: string, id: string, actor: Actor, now = Date.now()): Item {
	return mutateItem(home, idOf(id), item => {
		assertTransition(item, "open");
		item.status = "open";
		delete item.deferredUntil;
		addHistory(item, actor, "reopened", iso(now));
	}, new Date(now));
}

export function closeItem(home: string, id: string, actor: Actor, note: string | undefined, now = Date.now()): Item {
	return mutateItem(home, idOf(id), item => {
		assertTransition(item, "closed");
		item.status = "closed";
		addHistory(item, actor, "closed", iso(now), note);
	}, new Date(now));
}

export function withdrawItem(home: string, id: string, actor: Actor, reason: string, now = Date.now()): Item {
	return mutateItem(home, idOf(id), item => {
		assertTransition(item, "withdrawn");
		item.status = "withdrawn";
		addHistory(item, actor, "withdrawn", iso(now), reason);
	}, new Date(now));
}

const SURVIVOR_STATUSES: readonly Status[] = ["open", "deferred", "answered", "decided"];
const MAX_FORWARD_DEPTH = 5;
const NOTHING = new Error("nothing to change");

/**
 * Explicit resolution of a duplicate: S (source) is superseded by T (survivor).
 * a) validate before writing anything: S != T, T exists and is open, deferred, answered or decided, S exists.
 * b) CAS on S: already superseded by T is a recovery (no change); superseded by another, or a status that
 *    cannot become superseded, throws before anything is written; otherwise S is marked superseded by T.
 *    The committed revision R is kept.
 * c) CAS on T (eligibility re-checked inside): add R's asker and cc, idempotently.
 * Once S is superseded, addCc on S is forwarded to T (see addCc), so nothing committed to S after b) is lost.
 * Repeating the call is safe and completes a transfer that a crash interrupted between b) and c).
 */
export function supersedeItem(home: string, id: string, actor: Actor, byRaw: string, now = Date.now()): Item {
	const by = idOf(byRaw);
	const self = idOf(id);
	if (by === self) throw new Error("an item cannot supersede itself");
	const target = readItem(home, by);
	if (!target) throw new Error(`${by} does not exist`);
	if (!SURVIVOR_STATUSES.includes(target.status)) throw new Error(`${by} is ${target.status}; an item can only be superseded by one that is open, deferred, answered or decided`);
	if (!readItem(home, self)) throw new Error(`${self} does not exist`);
	const done = markSuperseded(home, self, by, actor, now);
	moveRecipients(home, done, by, actor, now);
	return done;
}

function markSuperseded(home: string, id: string, by: string, actor: Actor, now: number): Item {
	let seen: Item | undefined;
	try {
		return mutateItem(home, id, item => {
			if (item.status === "superseded") {
				if (item.supersededBy !== by) throw new Error(`${item.id} is already superseded by ${item.supersededBy}`);
				seen = item;
				throw NOTHING; // recovery or repeat: R is the revision already committed
			}
			assertTransition(item, "superseded");
			item.status = "superseded";
			item.supersededBy = by;
			if (!item.related.includes(by)) item.related.push(by);
			addHistory(item, actor, "superseded", iso(now), `superseded by ${by}`, { by });
		}, new Date(now));
	} catch (e) {
		if (e === NOTHING && seen) return seen;
		throw e;
	}
}

function moveRecipients(home: string, from: Item, toId: string, actor: Actor, now: number): void {
	const wanted = [...new Set([from.asker.lane ?? from.asker.sessionId, ...from.cc])];
	try {
		mutateItem(home, toId, item => {
			if (!SURVIVOR_STATUSES.includes(item.status)) throw new Error(`${item.id} is ${item.status}; it can no longer take over ${from.id}`);
			const add = wanted.filter(w => w !== item.asker.sessionId && w !== item.asker.lane && !item.cc.includes(w));
			if (!add.length) throw NOTHING;
			item.cc.push(...add);
			addHistory(item, actor, "linked", iso(now), `superseded ${from.id}`, { changed: ["cc"], cc: add });
		}, new Date(now));
	} catch (e) {
		if (e !== NOTHING) throw e;
	}
}

export function commentItem(home: string, id: string, actor: Actor, text: string, now = Date.now()): Item {
	if (!text.trim()) throw new Error("text is required");
	return mutateItem(home, idOf(id), item => {
		addHistory(item, actor, "comment", iso(now), text.trim());
	}, new Date(now));
}

export interface Patch { title?: string; body?: string; options?: unknown; urgency?: string; blocking?: string; links?: string[]; tags?: string[]; cc?: string[] }

export function addLinks(home: string, id: string, actor: Actor, links: string[], now = Date.now()): Item {
	return mutateItem(home, idOf(id), item => {
		const added = links.filter(l => !item.links.includes(l));
		item.links.push(...added);
		if (added.length) addHistory(item, actor, "linked", iso(now), added.join(", "), { links: added });
	}, new Date(now));
}

export function updateItem(home: string, id: string, actor: Actor, patch: Patch, now = Date.now()): Item {
	const forward = new Error("forward cc");
	const onlyCc = patch.cc !== undefined && Object.entries(patch).every(([k, v]) => k === "cc" || v === undefined);
	try {
		return updateOpen(home, id, actor, patch, now, onlyCc ? forward : undefined);
	} catch (e) {
		if (e !== forward) throw e;
		// A superseded item is never modified: the cc additions go to its replacement.
		let last: Item | undefined;
		for (const c of new Set(patch.cc)) last = addCc(home, id, actor, c, now);
		if (!last) throw new Error("nothing to update");
		return last;
	}
}

function updateOpen(home: string, id: string, actor: Actor, patch: Patch, now: number, forward?: Error): Item {
	return mutateItem(home, idOf(id), item => {
		if (item.status === "superseded" && forward) throw forward;
		if (item.status !== "open" && item.status !== "deferred") throw new Error(`${item.id} is ${item.status}; only open or deferred items can be edited`);
		const changed: string[] = [];
		const set = (k: keyof Patch, v: any) => {
			(item as any)[k] = v;
			changed.push(k);
		};
		if (patch.title !== undefined) set("title", patch.title.trim());
		if (patch.body !== undefined) set("body", patch.body.trim());
		if (patch.options !== undefined) set("options", validateOptions(patch.options));
		if (patch.urgency !== undefined) set("urgency", patch.urgency);
		if (patch.blocking !== undefined) set("blocking", patch.blocking.trim());
		if (patch.links !== undefined) set("links", [...new Set(patch.links)]);
		if (patch.tags !== undefined) set("tags", [...new Set(patch.tags)]);
		if (patch.cc !== undefined) set("cc", [...new Set(patch.cc)].filter(c => c !== item.asker.sessionId && c !== item.asker.lane));
		if (!changed.length) throw new Error("nothing to update");
		addHistory(item, actor, "edited", iso(now), changed.join(", "), { changed });
	}, new Date(now));
}

/**
 * Add `who` to cc so they get the answer too. A superseded item is never modified: the addition is forwarded
 * to the item that superseded it (following the chain, at most MAX_FORWARD_DEPTH hops). The returned item is the
 * one that was changed, so its id differs from `id` when the addition was forwarded.
 */
export function addCc(home: string, id: string, actor: Actor, who: string, now = Date.now()): Item {
	let target = idOf(id);
	for (let hop = 0; hop <= MAX_FORWARD_DEPTH; hop++) {
		let next: string | undefined;
		let seen: Item | undefined;
		try {
			return mutateItem(home, target, item => {
				if (item.status === "superseded") {
					if (!item.supersededBy) throw new Error(`${item.id} is superseded without a replacement; cannot add to cc`);
					next = item.supersededBy;
					throw NOTHING;
				}
				if (who === item.asker.sessionId || who === item.asker.lane || item.cc.includes(who)) {
					seen = item;
					throw NOTHING;
				}
				item.cc.push(who);
				addHistory(item, actor, "edited", iso(now), "cc", { changed: ["cc"], cc: who });
			}, new Date(now));
		} catch (e) {
			if (e !== NOTHING) throw e;
			if (seen) return seen;
			target = next!;
		}
	}
	throw new Error(`${id} was superseded through more than ${MAX_FORWARD_DEPTH} items; cannot add to cc`);
}
