/** Item model, validation, status transitions and ownership. No I/O. */

export const KINDS = ["question", "decision", "approval", "fyi"]         ;
export const STATUSES = ["open", "answered", "decided", "deferred", "withdrawn", "superseded", "closed"]         ;
export const URGENCIES = ["high", "normal", "low"]         ;
export const HISTORY_TYPES = [
	"created", "edited", "comment", "answered", "decided", "deferred", "reopened",
	"withdrawn", "superseded", "closed", "linked",
]         ;

                                          
                                               
                                                 
                                                         

export const MAX_TITLE = 120;
export const MAX_BODY = 4000;
export const MAX_SOURCE = 2000;

                                                     
                                                                                                  
                               
	            
	           
	             
	                  
	              
	                                 
 
                         
	             
	                
	           
	                         
	                
	                  
	           
 
                                                                                                          

                       
	           
	            
	           
	              
	             
	                  
	                     
	                 
	                 
	                
	               
	                    
	                 
	             
	             
	               
	                       
	                      
	                  
	                     
	                
	                        
	                  
	                  
 

                        
	           
	              
	             
	                  
	                     
	                 
	                 
	                
	               
	             
	                
	                 
	                       
 

export const ID_RE = /^Q-\d+$/;

/** "42", "Q-42" and "q42" all name Q-42. */
export function parseId(raw         )                {
	const m = /^q?-?(\d+)$/i.exec(String(raw ?? "").trim());
	return m ? `Q-${Number(m[1])}` : null;
}

export function idNumber(id        )         {
	return Number(id.slice(2));
}

function str(v         , name        , max        , required = false)         {
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

function strList(v         , name        )           {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v) || v.some(x => typeof x !== "string" || !x.trim())) throw new Error(`${name} must be a list of non-empty strings`);
	return [...new Set((v            ).map(x => x.trim()))];
}

function oneOf                  (v         , name        , allowed              , fallback    )    {
	if (v === undefined || v === null || v === "") {
		if (fallback) return fallback;
		throw new Error(`${name} is required (${allowed.join(" | ")})`);
	}
	if (!allowed.includes(v     )) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
	return v     ;
}

export function validateOptions(v         )           {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v)) throw new Error("options must be a list of {key, text}");
	const seen = new Set        ();
	return v.map(o => {
		const key = str(o?.key, "option key", 20, true);
		const text = str(o?.text, "option text", 300, true);
		if (seen.has(key)) throw new Error(`duplicate option key: ${key}`);
		seen.add(key);
		return { key, text };
	});
}

export function validateDraft(input                         )        {
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
		global: input.global === true,
		project: str(input.project, "project", 60) || undefined,
		distinctFrom: strList(input.distinctFrom, "distinctFrom").map(x => parseId(x) ?? x),
	};
}

/** Cheap structural check applied before every write. */
export function validateItem(item      )       {
	if (!ID_RE.test(item.id)) throw new Error(`invalid item id: ${item.id}`);
	if (!KINDS.includes(item.kind)) throw new Error(`invalid kind: ${item.kind}`);
	if (!STATUSES.includes(item.status)) throw new Error(`invalid status: ${item.status}`);
	if (!URGENCIES.includes(item.urgency)) throw new Error(`invalid urgency: ${item.urgency}`);
	if (!item.title || item.title.length > MAX_TITLE) throw new Error(`title must be 1-${MAX_TITLE} characters`);
	if (item.body.length > MAX_BODY) throw new Error(`body must be at most ${MAX_BODY} characters`);
	if (!Array.isArray(item.history)) throw new Error("history must be a list");
}

const TRANSITIONS                           = {
	open: ["answered", "decided", "deferred", "withdrawn", "superseded", "closed"],
	deferred: ["open", "answered", "decided", "withdrawn", "superseded", "closed"],
	answered: ["open", "decided", "superseded", "closed"],
	decided: ["open", "superseded", "closed"],
	withdrawn: ["open"],
	superseded: ["open"],
	closed: ["open"],
};

export function canTransition(from        , to        )          {
	return TRANSITIONS[from].includes(to);
}

export function assertTransition(item      , to        )       {
	if (!canTransition(item.status, to)) throw new Error(`${item.id} is ${item.status}; it cannot become ${to}`);
}

/** Own means the same session, or the same lane, as the asker. */
export function isOwn(item      , who                                      )          {
	if (item.asker.sessionId === who.sessionId) return true;
	return !!who.lane && item.asker.lane === who.lane;
}

/** Open, or deferred with the date reached (a deferral without a date never comes due). */
export function isActive(item      , now        )          {
	if (item.status === "open") return true;
	if (item.status !== "deferred" || !item.deferredUntil) return false;
	return Date.parse(item.deferredUntil) <= now;
}

export function addHistory(
	item      , actor       , type             , at        , text         , fields                          ,
)               {
	const entry               = { seq: (item.history.at(-1)?.seq ?? 0) + 1, at, actor, type };
	if (text !== undefined) entry.text = text;
	if (fields) entry.fields = fields;
	item.history.push(entry);
	return entry;
}

/** A history entry is delivered back to the asker when the user did it, or it is an answer or decision. */
export function isDeliverable(h              )          {
	return h.actor.kind === "user" || h.type === "answered" || h.type === "decided";
}
