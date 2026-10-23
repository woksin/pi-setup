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

                                                            
const LABEL_MAX = 80;
const actionable = (i      ) => i.status === "open" || i.status === "deferred";

/** Option keys in display order: the recommended one first, then the rest as authored. */
function orderedOptions(item      )                                                                   {
	const all = item.options.map((o, i) => ({ n: i + 1, key: o.key, text: o.text, recommended: o.key === item.recommended }));
	return [...all.filter(o => o.recommended), ...all.filter(o => !o.recommended)];
}

/** The option keys in brackets, slash-separated, with the recommended key starred; "" without options. */
export function optionsHint(item      )         {
	if (!item.options.length) return "";
	return `[${item.options.map(o => o.key + (o.key === item.recommended ? "*" : "")).join("/")}]`;
}

function idLabel(item      , withOptions         )         {
	const hint = withOptions ? optionsHint(item) : "";
	const head = `${item.id} ${item.title}`;
	if (!hint) return head.slice(0, LABEL_MAX);
	const room = LABEL_MAX - hint.length - 1;
	if (room < item.id.length + 4) return `${item.id} ${hint}`.slice(0, LABEL_MAX);
	const shown = head.length <= room ? head : `${head.slice(0, room - 3)}...`;
	return `${shown} ${hint}`;
}

/**
 * Completion entries for the first argument: ids of open or deferred items matching the prefix.
 * `withOptions` appends the option keys (recommended starred) to each label, for /decide and /q.
 */
export function completeIds(items        , prefix        , withOptions = false)                      {
	const p = prefix.trim().toLowerCase();
	if (p.includes(" ")) return null;
	const out = items
		.filter(actionable)
		.filter(i => `${i.id}`.toLowerCase().includes(p.replace(/^q-?/, "q-")) || i.id.slice(2).startsWith(p))
		.map(i => ({ value: i.id, label: idLabel(i, withOptions) }));
	return out.length ? out : null;
}

/**
 * Completion entries for an option argument. `head` is the text before the option (e.g. "Q-11 " or
 * "11 decide "), `id` the item id and `partial` what was typed of the option so far. Each value is
 * the whole argument text (pi replaces the full argument prefix), labelled "<n> <key> - <text>",
 * recommended first and marked.
 */
function optionCompletions(items        , head        , id        , partial        )                      {
	const item = items.find(i => i.id === id && actionable(i));
	if (!item || !item.options.length) return null;
	const p = partial.toLowerCase();
	const out = orderedOptions(item)
		.filter(o => !p || o.key.toLowerCase().startsWith(p) || String(o.n).startsWith(p))
		.map(o => ({
			value: `${head}${o.key}`,
			label: `${o.n} ${o.key} - ${o.text}${o.recommended ? " (recommended)" : ""}`.slice(0, LABEL_MAX),
		}));
	return out.length ? out : null;
}

/** /decide arguments: the id first, then that item's option keys (`/decide 11 yes`). */
export function completeDecide(items        , prefix        )                      {
	const m = /^(\S+)(\s+)(\S*)$/.exec(prefix.replace(/^\s+/, ""));
	if (!m) return completeIds(items, prefix, true);
	const id = parseId(m[1]);
	return id ? optionCompletions(items, `${id}${m[2]}`, id, m[3]) : null;
}

const Q_OPS = ["decide", "answer", "comment", "defer", "close", "reopen"];

/** /q arguments: the id, then the operation, then option keys after `decide`. */
export function completeQ(items        , prefix        )                      {
	const text = prefix.replace(/^\s+/, "");
	const withOp = /^(\S+)(\s+)(\S*)$/.exec(text);
	if (withOp) {
		const id = parseId(withOp[1]);
		if (!id || !items.some(i => i.id === id && actionable(i))) return null;
		const ops = Q_OPS.filter(op => op.startsWith(withOp[3].toLowerCase()));
		return ops.length ? ops.map(op => ({ value: `${id}${withOp[2]}${op}`, label: op })) : null;
	}
	const withOption = /^(\S+)(\s+)(decide)(\s+)(\S*)$/i.exec(text);
	if (withOption) {
		const id = parseId(withOption[1]);
		return id ? optionCompletions(items, `${id}${withOption[2]}decide${withOption[4]}`, id, withOption[5]) : null;
	}
	return completeIds(items, prefix, true);
}

