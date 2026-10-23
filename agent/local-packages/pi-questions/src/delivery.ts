/**
 * Delivery back to the asking session. Every session computes what it may deliver from the shared store,
 * claims a receipt per entry (first writer wins), then sends. At most once; no coordinator.
 */
import { deliveryLine, deliveryMessage } from "./format.ts";
import { isDeliverable, type HistoryEntry, type Item } from "./model.ts";

export const ORPHAN_MIN_AGE_MS = 60_000;

export interface Me { sessionId: string; lane?: string; repo: string | null }
export interface LiveSession { sessionId: string; lane?: string }
export interface Entry {
	item: Item;
	h: HistoryEntry;
	/** Receipt recipient key: "asker", "for:<entry>" or "cc:<entry>". Stable across restarts of the asker. */
	recipient: string;
	role: "asker" | "cc" | "for";
	mode: "wake" | "notice";
}

interface Routing { me: Me; live: LiveSession[]; now: number; orphanOk?: boolean }

function matchesRecipient(id: string, me: Me): boolean {
	return id === me.sessionId || (!!me.lane && id === me.lane);
}

function askerRecipient(item: Item, { me, live }: Routing): boolean {
	if (item.asker.sessionId === me.sessionId) return true;
	if (!me.lane) return false;
	if (item.asker.lane !== me.lane) return false;
	return !live.some(s => s.sessionId === item.asker.sessionId);
}

function askerOrLaneLive(item: Item, session: LiveSession): boolean {
	if (session.sessionId === item.asker.sessionId) return true;
	return !!item.asker.lane && session.lane === item.asker.lane;
}

function orphanRecipient(item: Item, h: HistoryEntry, ctx: Routing): boolean {
	if (!ctx.orphanOk) return false;
	if (item.repo === null || item.repo !== ctx.me.repo) return false;
	if (!(ctx.now - Date.parse(h.at) >= ORPHAN_MIN_AGE_MS)) return false;
	return !ctx.live.some(s => askerOrLaneLive(item, s));
}

function askerMode(item: Item, h: HistoryEntry, ctx: Routing): Entry["mode"] | undefined {
	// A for-recipient gets the wake, not a second copy as the asker or an orphan.
	if (item.for?.some(id => matchesRecipient(id, ctx.me))) return undefined;
	if (askerRecipient(item, ctx)) return item.for?.length ? "notice" : "wake";
	if (orphanRecipient(item, h, ctx)) return "notice";
	return undefined;
}

function forRecipient(id: string, item: Item, ctx: Routing): boolean {
	if (!matchesRecipient(id, ctx.me)) return false;
	if (id !== item.asker.lane) return true;
	if (ctx.me.sessionId === item.asker.sessionId) return true;
	return !ctx.live.some(s => s.sessionId === item.asker.sessionId);
}

function entryDetails({ item, h }: Entry) {
	const details = { id: item.id, seq: h.seq };
	return item.for?.length ? { ...details, for: item.for } : details;
}

/**
 * What session `me` may deliver now, split by mode.
 *  1. The recipient is me (my session id): wake.
 *  2. The recipient is my lane, and the asker's session is not live: wake. (A cc'd lane has no single session.)
 *  3. Orphan: the asker and every session of its lane are dead, I am in the same repo, the entry is at least
 *     60 s old, and `orphanOk` (just started, or idle): notice only.
 */
export function pending(
	items: Item[], me: Me, live: LiveSession[], receipts: Set<string>, now: number,
	opts: { orphanOk?: boolean; receiptName: (id: string, seq: number, recipient: string) => string },
): Entry[] {
	const out: Entry[] = [];
	const routing = { me, live, now, orphanOk: opts.orphanOk };
	for (const item of items) {
		const matches = (id: string) => matchesRecipient(id, me);
		for (const h of item.history) {
			if (!isDeliverable(h)) continue;
			const push = (recipient: string, role: Entry["role"], mode: Entry["mode"]) => {
				if (!receipts.has(opts.receiptName(item.id, h.seq, recipient))) out.push({ item, h, recipient, role, mode });
			};
			const mode = askerMode(item, h, routing);
			if (mode) push("asker", "asker", mode);
			for (const id of (item.for ?? []).filter(id => forRecipient(id, item, routing))) push(`for:${id}`, "for", "wake");
			for (const id of item.cc.filter(matches)) push(`cc:${id}`, "cc", "wake");
		}
	}
	return out;
}

export interface DeliveryHost {
	/** Throws when the extension context is stale (after /reload or session replacement). */
	isIdle(): boolean;
	/** An agent run is in progress (agent_start until agent_settled), so a follow-up is queued safely. */
	runActive(): boolean;
	handoffActive(): boolean;
	/** Throws when the context is stale. */
	send(message: { content: string; details: unknown }, mode: "wake" | "notice"): void;
}

export class Deliverer {
	private readonly holds = new Set<string>();
	private disposed = false;
	private readonly host: DeliveryHost;
	private readonly claim: (e: Entry) => boolean;
	private readonly unclaim: (e: Entry) => void;

	constructor(host: DeliveryHost, claim: (e: Entry) => boolean, unclaim: (e: Entry) => void) {
		this.host = host;
		this.claim = claim;
		this.unclaim = unclaim;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	/** A named hold (compaction, branch summarisation). Only the matching end event releases it, never time. */
	hold(name: string): void {
		this.holds.add(name);
	}

	release(name: string): void {
		this.holds.delete(name);
	}

	/** Delivery is held by a named hold or an active context-budget handoff. */
	get held(): boolean {
		if (this.holds.size) return true;
		try {
			return this.host.handoffActive();
		} catch {
			return false;
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	/**
	 * Returns how many entries were sent. Nothing is sent while held, or while pi is busy with something
	 * other than an agent run (not idle and no run active); the next poll or agent_end retries.
	 */
	deliver(entries: Entry[]): number {
		if (this.disposed || !entries.length || this.holds.size) return 0;
		try {
			if (this.host.handoffActive()) return 0;
			if (!this.host.isIdle() && !this.host.runActive()) return 0; // also the stale-context probe
		} catch {
			this.disposed = true;
			return 0;
		}
		let sent = 0;
		for (const mode of ["wake", "notice"] as const) {
			const claimed = entries.filter(e => e.mode === mode).filter(e => this.claim(e));
			if (!claimed.length) continue;
			const content = deliveryMessage(claimed.map(e => deliveryLine(e.item, e.h, e.role)));
			try {
				this.host.send({ content, details: { entries: claimed.map(entryDetails) } }, mode);
				sent += claimed.length;
			} catch {
				for (const e of claimed) this.unclaim(e);
				this.disposed = true;
				return sent;
			}
		}
		return sent;
	}
}
