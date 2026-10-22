/** Argument parsing for the user commands, and id completion. Pure. */
import { parseId,           } from "./model.js";

                                                           
const err = (error        ) => ({ error });

                           
	                                               
	                                    

export function parseQuestions(args        )                             {
	const [word, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	if (!word) return { ok: { mode: "open" } };
	if (word === "all" || word === "decided" || word === "repo") return { ok: { mode: word } };
	if (word === "search") {
		const terms = rest.join(" ");
		return terms ? { ok: { mode: "search", terms } } : err("usage: /questions search <terms>");
	}
	return err("usage: /questions [all|decided|repo|search <terms>]");
}

                   
	                                       
	                                                                  
	                                                            
	                                                            

function splitFirst(s        )                   {
	const t = s.trim();
	const i = t.search(/\s/);
	return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i).trim()];
}

/** YYYY-MM-DD as midnight UTC, in ISO form (so the date reads the same everywhere). Null if not a real date. */
export function parseDate(s        )                {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	if (!m) return null;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d.toISOString() : null;
}

function withId   (args        , usage        , fn                                              )                 {
	const [idRaw, rest] = splitFirst(args);
	const id = parseId(idRaw);
	return id ? fn(id, rest) : err(`usage: ${usage}`);
}

export const parseAnswer = (args        )                                                =>
	withId(args, "/answer <id> <text>", (id, text) => (text ? { ok: { id, op: "answer", text } } : err("usage: /answer <id> <text>")));

export const parseDecide = (args        )                                                =>
	withId(args, "/decide <id> <option key or number> [rationale]", (id, rest) => {
		const [option, text] = splitFirst(rest);
		return option ? { ok: { id, op: "decide", option, text } } : err("usage: /decide <id> <option key or number> [rationale]");
	});

export const parseDefer = (args        )                                               =>
	withId(args, "/defer <id> [YYYY-MM-DD] [reason]", (id, rest) => {
		const [first, more] = splitFirst(rest);
		if (/^\d{4}-\d{2}-\d{2}$/.test(first)) {
			const until = parseDate(first);
			return until ? { ok: { id, op: "defer", until, text: more } } : err(`${first} is not a valid date (YYYY-MM-DD)`);
		}
		return { ok: { id, op: "defer", text: rest } };
	});

export const parseClose = (args        )                                               =>
	withId(args, "/close <id> [reason]", (id, text) => ({ ok: { id, op: "close", text } }));

/** /q <id> [reopen | comment <text> | answer <text> | decide <opt> [why] | defer [date] [why] | close [why]] */
export function parseQ(args        )                     {
	return withId(args, "/q <id> [reopen|comment <text>|answer <text>|decide <option> [why]|defer [date] [why]|close [why]]", (id, rest) => {
		const [op, tail] = splitFirst(rest);
		switch (op) {
			case "": return { ok: { id, op: "show" } };
			case "reopen": return { ok: { id, op: "reopen" } };
			case "comment": return tail ? { ok: { id, op: "comment", text: tail } } : err("usage: /q <id> comment <text>");
			case "answer": return parseAnswer(`${id} ${tail}`);
			case "decide": return parseDecide(`${id} ${tail}`);
			case "defer": return parseDefer(`${id} ${tail}`);
			case "close": return parseClose(`${id} ${tail}`);
			default: return err(`unknown /q operation "${op}"`);
		}
	});
}

/** Completion entries for the first argument: ids of open or deferred items matching the prefix. */
export function completeIds(items        , prefix        )                                            {
	const p = prefix.trim().toLowerCase();
	if (p.includes(" ")) return null;
	const out = items
		.filter(i => i.status === "open" || i.status === "deferred")
		.filter(i => `${i.id}`.toLowerCase().includes(p.replace(/^q-?/, "q-")) || i.id.slice(2).startsWith(p))
		.map(i => ({ value: i.id, label: `${i.id} ${i.title}`.slice(0, 80) }));
	return out.length ? out : null;
}

