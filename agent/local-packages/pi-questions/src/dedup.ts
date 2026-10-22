/** Deterministic duplicate check: title-token Jaccard plus a bonus for a shared link. */
import type { Item } from "./model.ts";

export const THRESHOLD = 0.5;
export const NEAR_MISS_MIN = 0.35;
export const LINK_BONUS = 0.2;
export const WINDOW_DAYS = 180;

const STOP = new Set([
	"a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "be", "do", "we", "i", "it",
	"this", "that", "should", "can", "could", "would", "how", "what", "which", "about", "at", "by", "as", "from",
]);

function stem(w: string): string {
	if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
	if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
	if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
	if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
	return w;
}

/** Lower-case, strip punctuation, drop stopwords, crude stemming. */
export function tokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const w of text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
		if (w && !STOP.has(w)) out.add(stem(w));
	}
	return out;
}

/** "Owner/Repo#123" for issue and PR URLs and references; bare "#123" stays bare. */
export function linkTokens(...texts: string[]): Set<string> {
	const out = new Set<string>();
	for (const text of texts) {
		for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/gi)) out.add(`${m[1]}#${m[2]}`.toLowerCase());
		for (const m of text.matchAll(/([\w.-]+\/[\w.-]+)#(\d+)/g)) out.add(`${m[1]}#${m[2]}`.toLowerCase());
		for (const m of text.matchAll(/(?:^|[^\w/])#(\d+)/g)) out.add(`#${m[1]}`);
	}
	return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const x of a) if (b.has(x)) shared++;
	return shared / (a.size + b.size - shared);
}

export interface DraftLike { title: string; body: string; links: string[]; repo: string | null }
export interface Scored { item: Item; score: number }

const itemLinks = (i: { title: string; body: string; links: string[] }) => linkTokens(i.title, i.body, ...i.links);

export function score(draft: DraftLike, item: Item): number {
	let s = jaccard(tokens(draft.title), tokens(item.title));
	const mine = itemLinks(draft);
	if (mine.size) {
		const theirs = itemLinks(item);
		for (const l of mine) if (theirs.has(l)) {
			s += LINK_BONUS;
			break;
		}
	}
	return Math.min(1, s);
}

function inScope(draft: DraftLike, item: Item, now: number): boolean {
	if (item.repo !== null && item.repo !== draft.repo) return false;
	if (item.status === "withdrawn" || item.status === "superseded") return false;
	if (item.status === "decided" || item.status === "closed") {
		return now - Date.parse(item.updatedAt) <= WINDOW_DAYS * 86_400_000;
	}
	return true;
}

/** Candidates (score at least THRESHOLD) and near misses (NEAR_MISS_MIN up to THRESHOLD). */
export function candidates(items: Item[], draft: DraftLike, now: number): { candidates: Scored[]; nearMisses: Scored[] } {
	const scored = items.filter(i => inScope(draft, i, now)).map(item => ({ item, score: score(draft, item) }));
	const byScore = (a: Scored, b: Scored) => b.score - a.score;
	return {
		candidates: scored.filter(s => s.score >= THRESHOLD).sort(byScore),
		nearMisses: scored.filter(s => s.score >= NEAR_MISS_MIN && s.score < THRESHOLD).sort(byScore),
	};
}

/** Candidate ids that `distinctFrom` does not cover. Empty means the create may go ahead. */
export function uncovered(found: Scored[], distinctFrom: string[]): string[] {
	return found.map(c => c.item.id).filter(id => !distinctFrom.includes(id));
}

/** Two open items created within this long of each other and scoring as duplicates are shown as a possible duplicate. */
export const DUPLICATE_WINDOW_MS = 60_000;

/**
 * Read-time only, never stored: id -> the lowest id of an open item in the same scope that it duplicates.
 * Withdrawn, superseded, closed, answered and decided items are never targets or marked. Items the asker
 * declared distinct (`related`) are not marked.
 */
export function possibleDuplicates(items: Item[]): Map<string, string> {
	const open = items.filter(i => i.status === "open").sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
	const out = new Map<string, string>();
	for (const [n, hi] of open.entries()) {
		const lo = open.slice(0, n).find(l =>
			(l.repo === null || l.repo === hi.repo) && !hi.related.includes(l.id)
			&& Math.abs(Date.parse(hi.createdAt) - Date.parse(l.createdAt)) <= DUPLICATE_WINDOW_MS
			&& score({ title: hi.title, body: hi.body, links: hi.links, repo: hi.repo }, l) >= THRESHOLD);
		if (lo) out.set(hi.id, lo.id);
	}
	return out;
}
