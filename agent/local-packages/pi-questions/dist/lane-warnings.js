/** Shared warning for concurrent answer consumers of a mapped lane. */
import { liveness } from "./identity.js";
import { readSessions } from "./store.js";

/** Mapping a second live session to a lane is allowed, but its answer claims race. */
export function laneWarnings(home        , target                                     , now = Date.now())           {
	return readSessions(home).filter(s => s.sessionId !== target.sessionId)
		.filter(s => s.lane === target.lane).filter(s => liveness(s, s.mtimeMs, now))
		.map(s => `warning: ${target.lane} is also the lane of live session ${s.sessionId}; answers for ${target.lane} go to whichever session polls first`);
}
