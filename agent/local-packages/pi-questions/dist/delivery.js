/**
 * Delivery back to the asking session. Every session computes what it may deliver from the shared store,
 * claims a receipt per entry (first writer wins), then sends. At most once; no coordinator.
 */
import { deliveryLine, deliveryMessage } from "./format.js";
import { isDeliverable,                              } from "./model.js";

export const ORPHAN_MIN_AGE_MS = 60_000;

                                                                             
                                                                 
                        
	           
	                
	                                                                                                          
	                  
	                             
	                        
 

                                                                                  

function matchesRecipient(id        , me    )          {
	return id === me.sessionId || (!!me.lane && id === me.lane);
}

function askerRecipient(item      , { me, live }         )          {
	if (item.asker.sessionId === me.sessionId) return true;
	if (!me.lane) return false;
	if (item.asker.lane !== me.lane) return false;
	return !live.some(s => s.sessionId === item.asker.sessionId);
}

function askerOrLaneLive(item      , session             )          {
	if (session.sessionId === item.asker.sessionId) return true;
	return !!item.asker.lane && session.lane === item.asker.lane;
}

function orphanRecipient(item      , h              , ctx         )          {
	if (!ctx.orphanOk) return false;
	if (item.repo === null || item.repo !== ctx.me.repo) return false;
	if (!(ctx.now - Date.parse(h.at) >= ORPHAN_MIN_AGE_MS)) return false;
	return !ctx.live.some(s => askerOrLaneLive(item, s));
}

function askerMode(item      , h              , ctx         )                            {
	// A for-recipient gets the wake, not a second copy as the asker or an orphan.
	if (item.for?.some(id => matchesRecipient(id, ctx.me))) return undefined;
	if (askerRecipient(item, ctx)) return item.for?.length ? "notice" : "wake";
	if (orphanRecipient(item, h, ctx)) return "notice";
	return undefined;
}

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
	const routing = { me, live, now, orphanOk: opts.orphanOk };
	for (const item of items) {
		const matches = (id        ) => matchesRecipient(id, me);
		for (const h of item.history) {
			if (!isDeliverable(h)) continue;
			const push = (recipient        , role               , mode               ) => {
				if (!receipts.has(opts.receiptName(item.id, h.seq, recipient))) out.push({ item, h, recipient, role, mode });
			};
			const mode = askerMode(item, h, routing);
			if (mode) push("asker", "asker", mode);
			for (const id of (item.for ?? []).filter(matches)) push(`for:${id}`, "for", "wake");
			for (const id of item.cc.filter(matches)) push(`cc:${id}`, "cc", "wake");
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
