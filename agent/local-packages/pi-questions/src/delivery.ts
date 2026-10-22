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
	/** Receipt recipient key: "asker" or "cc:<entry>". Stable across restarts of the asker. */
	recipient: string;
	role: "asker" | "cc";
	mode: "wake" | "notice";
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
	for (const item of items) {
		const askerLive = live.some(s => s.sessionId === item.asker.sessionId);
		const laneLive = !!item.asker.lane && live.some(s => s.lane === item.asker.lane);
		for (const h of item.history) {
			if (!isDeliverable(h)) continue;
			const push = (recipient: string, role: "asker" | "cc", mode: "wake" | "notice") => {
				if (!receipts.has(opts.receiptName(item.id, h.seq, recipient))) out.push({ item, h, recipient, role, mode });
			};
			if (item.asker.sessionId === me.sessionId) push("asker", "asker", "wake");
			else if (me.lane && item.asker.lane === me.lane && !askerLive) push("asker", "asker", "wake");
			else if (
				opts.orphanOk && !askerLive && !laneLive && item.repo !== null && item.repo === me.repo
				&& now - Date.parse(h.at) >= ORPHAN_MIN_AGE_MS
			) push("asker", "asker", "notice");
			for (const c of item.cc) {
				if (c === me.sessionId || (me.lane && c === me.lane)) push(`cc:${c}`, "cc", "wake");
			}
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
				this.host.send({ content, details: { entries: claimed.map(e => ({ id: e.item.id, seq: e.h.seq })) } }, mode);
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
