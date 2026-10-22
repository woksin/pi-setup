/**
 * Delivery back to the asking session. Every session computes what it may deliver from the shared store,
 * claims a receipt per entry (first writer wins), then sends. At most once; no coordinator.
 */
import { deliveryLine, deliveryMessage } from "./format.js";
import { isDeliverable,                              } from "./model.js";

export const ORPHAN_MIN_AGE_MS = 60_000;

                                                                             
                                                                 
                        
	           
	                
	                                                                                           
	                  
	                     
	                        
 

/**
 * What session `me` may deliver now, split by mode.
 *  1. The recipient is me (my session id): wake.
 *  2. The recipient is my lane, and the asker's session is not live: wake. (A cc'd lane has no single session.)
 *  3. Orphan: the asker and every session of its lane are dead, I am in the same repo, the entry is at least
 *     60 s old, and `orphanOk` (just started, or idle): notice only.
 */
export function pending(
	items        , me    , live               , receipts             , now        ,
	opts                                                                                             ,
)          {
	const out          = [];
	for (const item of items) {
		const askerLive = live.some(s => s.sessionId === item.asker.sessionId);
		const laneLive = !!item.asker.lane && live.some(s => s.lane === item.asker.lane);
		for (const h of item.history) {
			if (!isDeliverable(h)) continue;
			const push = (recipient        , role                , mode                   ) => {
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

                               
	                                                                                         
	                  
	                                                                                                      
	                     
	                         
	                                        
	                                                                                    
 

export class Deliverer {
	                 holds = new Set        ();
	        disposed = false;
	                 host              ;
	                 claim                       ;
	                 unclaim                    ;

	constructor(host              , claim                       , unclaim                    ) {
		this.host = host;
		this.claim = claim;
		this.unclaim = unclaim;
	}

	get isDisposed()          {
		return this.disposed;
	}

	/** A named hold (compaction, branch summarisation). Only the matching end event releases it, never time. */
	hold(name        )       {
		this.holds.add(name);
	}

	release(name        )       {
		this.holds.delete(name);
	}

	/** Delivery is held by a named hold or an active context-budget handoff. */
	get held()          {
		if (this.holds.size) return true;
		try {
			return this.host.handoffActive();
		} catch {
			return false;
		}
	}

	dispose()       {
		this.disposed = true;
	}

	/**
	 * Returns how many entries were sent. Nothing is sent while held, or while pi is busy with something
	 * other than an agent run (not idle and no run active); the next poll or agent_end retries.
	 */
	deliver(entries         )         {
		if (this.disposed || !entries.length || this.holds.size) return 0;
		try {
			if (this.host.handoffActive()) return 0;
			if (!this.host.isIdle() && !this.host.runActive()) return 0; // also the stale-context probe
		} catch {
			this.disposed = true;
			return 0;
		}
		let sent = 0;
		for (const mode of ["wake", "notice"]         ) {
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
