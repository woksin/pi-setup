#!/usr/bin/env node
/**
 * pi-questions CLI: list, get, ask and wait from bash, for sessions that started before the extension
 * was installed. The asker comes from PI_SESSION_ID and PI_ORCH_ID. PI_QUESTIONS_HOME is respected.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as actions from "./actions.ts";
import { possibleDuplicates } from "./dedup.ts";
import { renderCandidates, renderItem, renderList, renderRecord } from "./format.ts";
import { cliSession, laneOf, repoOf } from "./identity.ts";
import { validateDraft, type Asker } from "./model.ts";
import { selectItems } from "./query.ts";
import { agentDir, listItems, resolveHome } from "./store.ts";

export interface Io { out(s: string): void; err(s: string): void }

const USAGE = `usage: pi-questions <command>
  list [--all] [--mine] [--status S] [--repo Owner/Name] [--project P]
  get <id> [--record]
  ask --kind question|decision|approval|fyi --title T [--body B] [--option key=text]... [--recommended key]
      [--urgency high|normal|low] [--blocking X] [--cc ID]... [--link L]... [--tag T]... [--global]
      [--project P] [--distinct-from Q-n]...
  wait <id>...  exit 0 once any given item is answered, decided or closed; exit 1 while all are open.
                Checks once and returns: run it as the job_watch check (until=success), alone, not chained.`;

export function main(argv: string[], env: Record<string, string | undefined>, io: Io, cwd = process.cwd()): number {
	const [cmd, ...rest] = argv;
	const home = resolveHome(env);
	const session = cliSession(env, cwd, agentDir(env));
	const sessionId = session.sessionId || `cli-${process.pid}`;
	const lane = laneOf(env, sessionId, session.name);
	try {
		switch (cmd) {
			case "list": {
				const { values } = parseArgs({ args: rest, options: { all: { type: "boolean" }, mine: { type: "boolean" }, status: { type: "string" }, repo: { type: "string" }, project: { type: "string" } } });
				const { items, warnings } = listItems(home);
				const now = Date.now();
				const picked = selectItems(items, { all: values.all, mine: values.mine, status: values.status as any, repo: values.repo, project: values.project }, { sessionId, lane, repo: repoOf(cwd) }, now);
				io.out(renderList(picked, { now, showAsker: values.all, warnings, empty: "No matching items.", duplicates: possibleDuplicates(items) }));
				return 0;
			}
			case "get": {
				const { values, positionals } = parseArgs({ args: rest, options: { record: { type: "boolean" } }, allowPositionals: true });
				if (!positionals[0]) throw new Error("get needs an id");
				const item = actions.getItem(home, positionals[0]);
				io.out(values.record ? renderRecord(item) : renderItem(item, Date.now(), possibleDuplicates(listItems(home).items).get(item.id)));
				return 0;
			}
			case "wait": {
				if (!rest[0]) throw new Error("wait needs an id");
				let anyDone = false;
				for (const id of rest) {
					const item = actions.getItem(home, id);
					const done = item.status === "answered" || item.status === "decided" || item.status === "closed";
					anyDone ||= done;
					io.out(`${item.id} is ${item.status}${item.answer ? `: ${item.answer.text}` : ""}`);
				}
				if (!anyDone) io.out("not answered yet (exit 1)");
				return anyDone ? 0 : 1;
			}
			case "ask": {
				const { values } = parseArgs({
					args: rest,
					options: {
						kind: { type: "string" }, title: { type: "string" }, body: { type: "string" }, option: { type: "string", multiple: true },
						recommended: { type: "string" }, urgency: { type: "string" }, blocking: { type: "string" }, cc: { type: "string", multiple: true },
						link: { type: "string", multiple: true }, tag: { type: "string", multiple: true }, global: { type: "boolean" },
						project: { type: "string" }, "distinct-from": { type: "string", multiple: true },
					},
				});
				const options = (values.option ?? []).map(o => {
					const i = o.indexOf("=");
					if (i < 1) throw new Error(`--option must be key=text, got "${o}"`);
					return { key: o.slice(0, i), text: o.slice(i + 1) };
				});
				const draft = validateDraft({
					kind: values.kind, title: values.title, body: values.body, options, recommended: values.recommended, urgency: values.urgency,
					blocking: values.blocking, cc: values.cc, links: values.link, tags: values.tag, global: values.global, project: values.project,
					distinctFrom: values["distinct-from"],
				});
				const asker: Asker = { sessionId, lane, cwd, repo: repoOf(cwd), pid: process.pid };
				const res = actions.ask(home, draft, asker);
				if ("refused" in res) {
					io.err(["Not created: possible duplicate of existing items.", renderCandidates(res.refused.candidates, res.refused.nearMisses),
						`To create anyway, repeat with ${res.refused.candidates.map(c => `--distinct-from ${c.item.id}`).join(" ")}`].join("\n"));
					return 2;
				}
				io.out(`Created ${res.ok.item.id}: ${res.ok.item.title}\nWait for the answer with: pi-questions wait ${res.ok.item.id}`);
				return 0;
			}
			default:
				io.err(USAGE);
				return cmd ? 2 : 0;
		}
	} catch (e: any) {
		io.err(`error: ${e.message}`);
		return 2;
	}
}

function isEntry(): boolean {
	try {
		return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntry()) {
	process.exitCode = main(process.argv.slice(2), process.env, { out: s => console.log(s), err: s => console.error(s) });
}
