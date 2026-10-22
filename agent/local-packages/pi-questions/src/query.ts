/** Selecting and searching items. Pure. */
import { tokens } from "./dedup.ts";
import { isActive, isOwn, type Item, type Kind, type Status } from "./model.ts";

export interface Who { sessionId: string; lane?: string; repo: string | null }
export interface Filter { status?: Status | "all"; repo?: string; all?: boolean; mine?: boolean; project?: string }

/**
 * Default: open and deferred-due items in this repo, global items, and the caller's own items.
 * `all` drops the repo scope (every repo); `repo` pins one repo; `project` filters by project tag.
 */
export function selectItems(items: Item[], f: Filter, me: Who, now: number): Item[] {
	return items.filter(i => {
		if (f.status === undefined || f.status === "open") {
			if (!isActive(i, now)) return false;
		} else if (f.status !== "all" && i.status !== f.status) return false;
		if (f.repo) {
			if (i.repo !== f.repo) return false;
		} else if (!f.all && !(i.repo === me.repo || i.repo === null || isOwn(i, me))) return false;
		if (f.mine && !isOwn(i, me)) return false;
		if (f.project && i.project !== f.project) return false;
		return true;
	});
}

export function searchItems(
	items: Item[], q: { query: string; status?: Status; kind?: Kind; repo?: string; tag?: string }, limit = 20,
): Item[] {
	const want = tokens(q.query);
	if (!want.size) return [];
	const scored: { item: Item; score: number }[] = [];
	for (const item of items) {
		if (q.status && item.status !== q.status) continue;
		if (q.kind && item.kind !== q.kind) continue;
		if (q.repo && item.repo !== q.repo) continue;
		if (q.tag && !item.tags.includes(q.tag)) continue;
		const have = tokens([item.title, item.body, item.answer?.text ?? "", ...item.tags].join(" "));
		let shared = 0;
		for (const w of want) if (have.has(w)) shared++;
		if (shared) scored.push({ item, score: shared / want.size });
	}
	return scored.sort((a, b) => b.score - a.score || Number(b.item.id.slice(2)) - Number(a.item.id.slice(2))).slice(0, limit).map(s => s.item);
}

export function counts(active: Item[]): { open: number; blocking: number } {
	return { open: active.length, blocking: active.filter(i => i.blocking).length };
}
