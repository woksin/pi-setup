/** Shared warning for concurrent answer consumers of a mapped lane. */
import { liveness } from "./identity.ts";
import { readSessions } from "./store.ts";

/** Mapping a second live session to a lane is allowed, but its answer claims race. */
export function laneWarnings(home: string, target: { sessionId: string; lane: string }, now = Date.now()): string[] {
	return readSessions(home).filter(s => s.sessionId !== target.sessionId)
		.filter(s => s.lane === target.lane).filter(s => liveness(s, s.mtimeMs, now))
		.map(s => `warning: ${target.lane} is also the lane of live session ${s.sessionId}; answers for ${target.lane} go to whichever session polls first`);
}
