# pi-questions

A durable queue of questions, decisions, approvals and FYIs for the user, for [pi](https://github.com/earendil-works/pi). Any pi session can use it, inside or outside a lane system. When the user answers an item, the answer goes straight back to the session that asked. Nothing here asks for approval or blocks a session.

## Install

```
pi install npm:@woksin/pi-questions
```

Or add the package path to `packages` in pi's `settings.json`. Needs Node 22.18 or later (native type stripping).

## Model

Each item has a kind (`question`, `decision`, `approval`, `fyi`), a title (at most 120 characters), a plain-text body (at most 4000), optional options with a recommended key, an urgency (`high`, `normal`, `low`), a `blocking` note (what is waiting; non-empty means blocking), links, tags, a repo, an optional `project` tag, the asker (session, lane, cwd, repo) and `cc` entries (lane ids or session ids that should also get the answer).

Status is one of `open`, `answered`, `decided`, `deferred`, `withdrawn`, `superseded`, `closed`. The full history (created, edited, comment, answered, decided, deferred, reopened, withdrawn, superseded, closed, linked) stays inside the item. Nothing is ever deleted: decided and closed items form the decisions log.

The repo is `Owner/Name` from the git origin, so all worktrees of one repo share it; otherwise the basename of the git common dir's parent; outside git, or with `global: true`, it is empty (global). The `project` tag groups work across repos.

## Agent tool: `user_questions`

One tool with an `action`:

- `ask`: kind, title, body, options, recommended, urgency, blocking, links, tags, cc, for, global, project, distinctFrom. A duplicate check runs first (below).
- `list`: default is open and deferred-due items for the current repo, global items and your own. `all: true` shows every repo with the asker lane on each item. `project`, `repo`, `status` (or `all`), `mine` filter.
- `get`: `format: "text"` or `"record"` (a plain decision record for exporting by hand).
- `search`: all statuses, so agents check decided and closed items before asking again.
- `update`: your own open or deferred items. On any item you may add links, or add yourself to cc.
- `comment`: any item.
- `withdraw`, `supersede`, `close`: your own items. `close` applies to answered or decided items, or fyi. "Own" means the same session or the same lane as the asker.
- `record_answer`: only the user's exact words (see below).

Subagents (no UI) get `list`, `get` and `search` only; mutations are refused with "report to your parent session". Subagents also get no status line, no heartbeat and no delivery.

### Duplicate check

Titles are lower-cased, stripped of punctuation and stopwords, and crudely stemmed. The score is the Jaccard index of the title tokens, plus 0.2 when the items share a link (#123, PR or issue URLs, `Owner/Repo#n`), capped at 1. Candidates (score 0.5 or more) come from open, deferred and answered items, plus decided or closed items from the last 180 days, in the same repo or global. Any candidate refuses the create and lists each with id, status, title and answer. Comment on it, add yourself to cc, or use its answer. To create anyway, ask again with `distinctFrom` listing every candidate id; they are recorded as `related`. Near misses (0.35 to 0.5) are reported in the result `details.nearMisses`, so the threshold can be tuned (constants in `src/dedup.ts`).

### Verbatim answers

User commands are verbatim by construction. `record_answer` is for an answer the user typed in the session's chat: the extension keeps the last 10 interactive inputs in memory, and the quote must be a whitespace-normalised, case-sensitive substring of one of them. The answer stores the quote and the full input as `source`. Text relayed through message files, tools or other sessions never counts. A lane cannot record what it read in a message from L0; L0 records it in its own session, where the user typed it, and the answer is delivered to the asking lane.

`answer.by` is `githubUser` from `<agent dir>/user.json`, else the OS user.

## User commands

- `/questions [all|decided|repo|search <terms>]`: open items grouped as Blocking, High, Normal, Low. `all` shows every repo with asker lanes.
- `/q <id> [reopen|comment <text>|answer|decide|defer|close ...]`: show or act on one item.
- `/answer <id> <text>`, `/decide <id> <option key or number> [rationale]`, `/defer <id> [YYYY-MM-DD] [reason]`, `/close <id> [reason]`.
- `/lane [ID|clear]`: show, set or clear the current session's lane mapping.
- Tab completion: question commands complete the id. For `/decide` and `/q`, the id list also shows each item's options, with the recommended key starred (`[no/yes*/later]`). After `/decide <id> ` (or `/q <id> decide `) it completes that item's option keys, labelled `<n> <key> - <text>`, with the recommended option first and marked. `/q <id> ` completes the operation.

Ids may be written `42`, `Q-42` or `q42`; commands complete open ids. Output is plain text: no blockquotes, and list lines are at most 100 columns wide. A status line shows "Q 5 open, 2 blocking" plus ", 1 answered for you" when an answer is waiting to be delivered; it is hidden at zero.

## Delivery

Every UI session watches `items/` (debounced 500 ms), polls every 20 s as a fallback, and keeps a 30 s heartbeat. Recipients are the asker and each cc entry. Session S may deliver a history entry (user actions, answers, decisions) when:

1. the recipient is S's own session id;
2. the recipient is S's lane id and the asker's session is not live (a lane restart still gets the answer);
3. orphan: the asker and every session of its lane are dead, S is in the same repo, the entry is at least 60 s old, and S has just started or is idle. This sends a `nextTurn` notice and does not start a turn.

S claims `receipts/<Q-n>.<seq>.<recipient>.json` with `link()` before sending (first claim wins, so at most once). Wakes use `pi.sendMessage({customType: "user-question", ...}, {triggerTurn: true, deliverAs: "followUp"})`. Delivery is held from `session_before_compact` until `session_compact` (or `session_compact_failed`), from `session_before_tree` until `session_tree` (or the next `agent_start`), and while context-budget reports a handoff. A hold ends only with its end event, never because time passed; a hold with answers waiting shows "(delivery held)" in the status line. Nothing is sent while pi is busy without an agent run; the next poll or `agent_end` retries. If `sendMessage` throws (stale context after `/reload`), the receipt is released and delivery stops for that instance. A crash between claim and send can lose the wake, but the answer stays on the item and in the status line.

## Routing

Lane identity is resolved in this order: `PI_ORCH_ID`, the per-session identity map, the pi-orch heartbeat, then a lane-shaped session name (`/name`). Lane ids start with an uppercase letter and contain 2–16 letters, digits or hyphens, including `L18b`, `R-CHR` and `PISETUP`. Session names are stricter: uppercase letters, digits and hyphens, with at most one trailing lowercase letter (`L18b`, not `Review`). `/lane L47` maps this session; `/lane` shows the effective identity; `/lane clear` removes the map entry and restores the fallbacks. `/lane <ID>` writes nothing when `PI_ORCH_ID` is set and reports its precedence. Mapping never changes `process.env`, so inferred identity is not inherited by child sessions. The CLI reads the latest persisted `session_info` name from `PI_SESSION_FILE`, or locates `PI_SESSION_ID` in the current cwd's Pi sessions directory under `PI_CODING_AGENT_DIR` (default `~/.pi/agent`). Missing or unreadable session metadata leaves the session-id fallback.

A coordinator can map running lanes without reloading them: `pi-questions lane set L47 --tty ttys012` (also accepts `/dev/ttys012`), `--pid <pid>`, or `--session <id>`. PID and tty selectors use live store heartbeats and refuse missing or ambiguous matches; use an explicit session id to disambiguate. Setting a lane already held by another live session warns about racing answer claims but still applies the map. `pi-questions lane list` shows mappings; `pi-questions lane clear --session <id>` removes one. Each delivery pass recomputes identity and updates the heartbeat, so an external map change takes effect within one poll. `lanes start` already sets `PI_ORCH_ID`; mapping is for sessions started without it, and does not override that environment variable.

Ask on a lane's behalf with `user_questions {action: "ask", kind: "question", title: "…", for: ["L47"]}` or `pi-questions ask --kind question --title "…" --for L47`. `for` accepts up to five lane or session ids (repeat `--for` for several). Each recipient gets a follow-up wake, and the asker gets only a `nextTurn` notice unless it is itself a recipient. Receipt keys are `for:<id>`: if several sessions share a lane, the first claim wins, so that lane is woken once per entry. If it is the asker's own lane and the asker is still live, its peers leave that claim to the asker. `/questions` shows `for <ids>`; waiting lane answers appear as `N answered for L47` in the status line.

If a `for` lane has no live session, its receipt remains unclaimed; the next session mapped to that lane wakes on its first delivery pass, without the orphan delay. Items without `for` keep their existing delivery rules: the exact asker receives the wake while live, and after it exits a new session of the same mapped lane can take over. Map each replacement session to the same lane id to retain that routing.

## Storage

`PI_QUESTIONS_HOME`, else `<agent dir>/user-questions` (agent dir is `PI_CODING_AGENT_DIR` or `~/.pi/agent`). Both the extension and the CLI honour it.

- `items/Q-<n>/r<rev>.json`: an item is a directory of immutable revision files, each linked into place with `link()` (first writer wins). The state is the highest revision. If it cannot be read or parsed, reads, writes and the list refuse it (a list skips that item with a warning) rather than rolling back to an older revision; nothing is written until it is repaired. A writer that loses a race re-reads and retries (bounded by 200 attempts and a 5 s deadline, then a clear error). There are no locks. Two askers that pass the duplicate check at the same moment simply both create an item: nothing reconciles them automatically. `list`, `get` and `/questions` mark "possible duplicate of Q-<lower>" when two open items in the same scope score at or above the duplicate threshold and were created within 60 s of each other (computed when reading, never stored; withdrawn, closed and other non-open items are never marked or targets). Resolving is an explicit action: `supersede {id, by}` (or the user's `/close`) marks the item superseded, then adds its asker and cc to the replacement's cc in one compare-and-swap mutation. The replacement must be open, deferred, answered or decided; repeating the call is safe and finishes an interrupted transfer. Adding to the cc of a superseded item is forwarded to its replacement (up to 5 hops). Id allocation is bounded too (attempts and deadline).
- `lanes/<sessionId>.json`: atomic identity mapping `{lane, sessionId, setBy, at}`, one file per session.
- `sessions/` (heartbeats), `receipts/` (immutable delivery claims).
- Ids are one global sequence and are never reused.

## CLI

For sessions that started before the package was installed. The asker comes from `PI_SESSION_ID` and `PI_ORCH_ID`.

```
pi-questions list [--all] [--mine] [--status S] [--repo Owner/Name] [--project P]
pi-questions get <id> [--record]
pi-questions ask --kind question --title T [--body B] [--option key=text]... [--recommended key]
                 [--urgency high|normal|low] [--blocking X] [--cc ID]... [--for ID]... [--link L]... [--tag T]...
                 [--global] [--project P] [--distinct-from Q-n]...
pi-questions lane set <ID> (--session <id> | --pid <pid> | --tty <ttysNN>)
pi-questions lane clear --session <id>
pi-questions lane list
pi-questions wait <id>...
```

`wait` checks once and returns: exit 0 if any given item is answered, decided or closed, else 1 (several ids are allowed). Use it alone as the watch check; chaining other commands after it (`wait Q-1; list`) makes the check exit 0 at once. To be woken without a reload, use pi-jobs: `job_watch "pi-questions wait Q-42" until=success interval=120`. The installed `bin` is plain JavaScript (`dist/cli.js`, built by `prepack`), because Node does not strip types under `node_modules`. From a checkout, run `node src/cli.ts ...`.

## Development

`npm test` runs the offline suite (Node's built-in runner).
