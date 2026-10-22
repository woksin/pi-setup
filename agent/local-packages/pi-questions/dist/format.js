/** Plain text renderers. No blockquotes (no line starts with ">"), list and table lines at most 100 wide. */
                                                     
                                         

export const WIDTH = 100;

/** Break one logical line at spaces to fit `width`; continuation lines get `hang`. Long words are split. */
export function wrap(line        , width = WIDTH, hang = "")           {
	const out           = [];
	let cur = "";
	const room = () => Math.max(1, width - (out.length ? hang.length : 0)); // at least 1, so splitting always progresses
	const flush = () => {
		out.push((out.length ? hang : "") + cur);
		cur = "";
	};
	const lead = /^\s*/.exec(line) [0];
	cur = lead;
	for (let word of line.trim().split(/\s+/)) {
		if (!word) continue;
		const sep = cur.trim() ? " " : "";
		if (cur.length + sep.length + word.length <= room()) {
			cur += sep + word;
			continue;
		}
		if (cur.trim()) flush();
		while (word.length > room()) {
			cur = word.slice(0, room());
			word = word.slice(room());
			flush();
		}
		cur = word;
	}
	if (cur.trim() || !out.length) flush();
	return out;
}

/** Lines that already fit are left untouched (keeps the author's spacing); longer ones are wrapped. */
const fit = (l        , hang = "  ") => (l.length <= WIDTH ? [l] : wrap(l, WIDTH, hang));

/** Final pass for every renderer: nothing may start with ">". */
export function plain(lines          )         {
	return lines.map(l => (l.startsWith(">") ? ` ${l}` : l)).join("\n");
}

export function ageOf(iso        , now        )         {
	const ms = Math.max(0, now - Date.parse(iso));
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m}m`;
	if (m < 60 * 48) return `${Math.floor(m / 60)}h`;
	return `${Math.floor(m / 1440)}d`;
}

export const askerName = (item      ) => item.asker.lane ?? item.asker.sessionId.slice(0, 8);

function itemLines(item      , now        , showAsker         )           {
	const head = `${item.id} [${item.kind}] ${item.title}`;
	const meta = [item.status === "deferred" && item.deferredUntil ? `deferred until ${item.deferredUntil.slice(0, 10)}` : item.status, item.urgency];
	meta.push(item.repo ?? "global");
	if (item.project) meta.push(`project ${item.project}`);
	if (showAsker) meta.push(`asker ${askerName(item)}`);
	meta.push(ageOf(item.createdAt, now));
	if (item.blocking) meta.push(`blocks: ${item.blocking}`);
	return [...wrap(head, WIDTH, "      "), ...wrap(`    ${meta.join(", ")}`, WIDTH, "      ")];
}

/** Items grouped as Blocking, High, Normal, Low; within a group by repo, then id. */
export function renderList(items        , opts                                                                                                                               )         {
	const lines           = [];
	if (opts.heading) lines.push(...wrap(opts.heading));
	if (!items.length) lines.push(opts.empty ?? "No items.");
	const groups                                   = [
		["Blocking", i => !!i.blocking],
		["High", i => !i.blocking && i.urgency === "high"],
		["Normal", i => !i.blocking && i.urgency === "normal"],
		["Low", i => !i.blocking && i.urgency === "low"],
	];
	const num = (i      ) => Number(i.id.slice(2));
	for (const [name, pick] of groups) {
		const group = items.filter(pick).sort((a, b) => (a.repo ?? "").localeCompare(b.repo ?? "") || num(a) - num(b));
		if (!group.length) continue;
		lines.push(`${name} (${group.length})`);
		for (const item of group) {
			lines.push(...itemLines(item, opts.now, !!opts.showAsker));
			const dup = opts.duplicates?.get(item.id);
			if (dup) lines.push(`      possible duplicate of ${dup}`);
		}
	}
	for (const w of opts.warnings ?? []) lines.push(...wrap(`warning: ${w}`));
	return plain(lines);
}

function answerLine(item      )                     {
	const a = item.answer;
	if (!a) return undefined;
	const how = a.via === "quote" ? "quote in chat" : "command";
	const opt = a.option ? ` [option ${a.option}${item.options.find(o => o.key === a.option) ? `: ${item.options.find(o => o.key === a.option) .text}` : ""}]` : "";
	return `Answer${opt}: ${a.text} (by ${a.by} via ${how}, ${a.at})`;
}

export function renderItem(item      , now        , duplicateOf         )         {
	const lines           = [];
	lines.push(...wrap(`${item.id} [${item.kind}] ${item.title}`, WIDTH, "  "));
	lines.push(`Status: ${item.status}${item.deferredUntil ? ` until ${item.deferredUntil.slice(0, 10)}` : ""}   Urgency: ${item.urgency}   Age: ${ageOf(item.createdAt, now)}   rev ${item.rev}`);
	lines.push(`Repo: ${item.repo ?? "global"}${item.project ? `   Project: ${item.project}` : ""}   Asker: ${askerName(item)} (session ${item.asker.sessionId})`);
	if (item.blocking) lines.push(...wrap(`Blocking: ${item.blocking}`, WIDTH, "  "));
	if (item.cc.length) lines.push(`Also notified: ${item.cc.join(", ")}`);
	if (item.links.length) lines.push(...wrap(`Links: ${item.links.join(", ")}`, WIDTH, "  "));
	if (item.tags.length) lines.push(`Tags: ${item.tags.join(", ")}`);
	if (item.related.length) lines.push(`Related: ${item.related.join(", ")}`);
	if (item.supersededBy) lines.push(`Superseded by: ${item.supersededBy}`);
	if (duplicateOf) lines.push(`Possible duplicate of ${duplicateOf} (same question, created at about the same time). Resolve with supersede by ${duplicateOf}, or /close.`);
	if (item.body) lines.push("", ...item.body.split("\n"));
	if (item.options.length) {
		lines.push("", "Options:");
		for (const o of item.options) lines.push(...wrap(`  ${o.key}${o.key === item.recommended ? " (recommended)" : ""}: ${o.text}`, WIDTH, "      "));
	}
	const a = answerLine(item);
	if (a) lines.push("", ...wrap(a, WIDTH, "  "));
	lines.push("", "History:");
	for (const h of item.history) lines.push(...wrap(`  #${h.seq} ${h.at.slice(0, 16)} ${h.actor.kind}${h.actor.name ? ` ${h.actor.name}` : ""} ${h.type}${h.text ? `: ${h.text}` : ""}`, WIDTH, "      "));
	return plain(lines.flatMap(l => fit(l)));
}

/** A plain decision-record block for exporting by hand. */
export function renderRecord(item      )         {
	const lines = [`Decision record ${item.id}: ${item.title}`, `Kind: ${item.kind}`, `Status: ${item.status}`, `Repo: ${item.repo ?? "global"}`];
	if (item.project) lines.push(`Project: ${item.project}`);
	if (item.links.length) lines.push(`Links: ${item.links.join(", ")}`);
	lines.push(`Asked: ${item.createdAt}`);
	if (item.body) lines.push("", "Context:", ...item.body.split("\n"));
	if (item.options.length) lines.push("", "Options:", ...item.options.map(o => `  ${o.key}: ${o.text}`));
	const a = item.answer;
	if (a) {
		const picked = a.option ? item.options.find(o => o.key === a.option) : undefined;
		lines.push("", `Outcome: ${a.option ? `${a.option}${picked ? ` (${picked.text})` : ""}` : "answered"}`, `Statement: ${a.text}`, `Decided by ${a.by} on ${a.at}`);
	} else lines.push("", "Outcome: none recorded");
	return plain(lines);
}

export function renderCandidates(found          , nearMisses           = [])         {
	const lines           = [];
	for (const { item, score } of found) {
		lines.push(...wrap(`${item.id} [${item.status}] ${item.title} (score ${score.toFixed(2)})`, WIDTH, "    "));
		if (item.answer) lines.push(...wrap(`    answer: ${item.answer.text}`, WIDTH, "      "));
	}
	for (const { item, score } of nearMisses) lines.push(...wrap(`near miss: ${item.id} [${item.status}] ${item.title} (score ${score.toFixed(2)})`, WIDTH, "    "));
	return plain(lines);
}

export function statusText(counts                                                                      )                     {
	if (!counts.open && !counts.answered) return undefined;
	const parts = [`Q ${counts.open} open`];
	if (counts.blocking) parts.push(`${counts.blocking} blocking`);
	if (counts.answered) parts.push(`${counts.answered} answered for you`);
	return parts.join(", ") + (counts.held ? " (delivery held)" : "");
}

const VIA = (h              , item      ) => (h.type === "answered" || h.type === "decided") && item.answer ? item.answer.via : undefined;

/** One delivered history entry as a sentence. The user's words are quoted verbatim, never wrapped. */
export function deliveryLine(item      , h              , role                )         {
	const who = h.actor.name ?? (h.actor.kind === "user" ? "the user" : "an agent");
	const subject = role === "asker" ? `your question: ${item.title}` : `${item.title}`;
	const via = VIA(h, item);
	const how = via === "quote" ? "via quote in chat" : via === "command" ? "via command" : "";
	const tail = `by ${who}${how ? ` ${how}` : ""} at ${h.at}. Status: ${item.status}.`;
	switch (h.type) {
		case "answered": return `Answer for ${item.id} (${subject}): ${h.text ?? item.answer?.text ?? ""} - ${tail}`;
		case "decided": {
			const key = item.answer?.option;
			const opt = key ? `option ${key}${item.options.find(o => o.key === key) ? ` (${item.options.find(o => o.key === key) .text})` : ""}` : "decided";
			return `Decision for ${item.id} (${subject}): ${opt}${h.text ? `. ${h.text}` : ""} - ${tail}`;
		}
		case "comment": return `Comment on ${item.id} (${subject}) from ${who}: ${h.text ?? ""} - at ${h.at}. Status: ${item.status}.`;
		default: return `${who} ${h.type} ${item.id} (${subject})${h.text ? `: ${h.text}` : ""} - at ${h.at}. Status: ${item.status}.`;
	}
}

export function deliveryMessage(lines          )         {
	const body = lines.length === 1 ? lines[0] : `${lines.length} updates on questions for the user:\n\n${lines.join("\n\n")}`;
	return plain(body.split("\n"));
}
