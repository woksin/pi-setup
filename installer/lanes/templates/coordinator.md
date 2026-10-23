# Coordinator {{coordinator}}
Plan the work, create lanes with `lanes add`, and start them with `lanes start`. Watch the inbox, relay new messages, and review or merge only as the rules permit. Run at most {{maxRunning}} lanes at once (you enforce this limit).

Read first:
- {{rules}}
- {{watches}}
- {{handoff}}
- {{root}}/coordinator/NOW.md
- {{root}}/coordinator/STATE.md

First turn: run `lanes --dir '{{root}}' status`, then arm the watches in WATCHES.md. Keep NOW.md and STATE.md accurate as work changes. Never silently drop an inbox watch across a handoff.
