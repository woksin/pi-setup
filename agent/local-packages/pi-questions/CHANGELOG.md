# Changelog

## 0.1.0

- `user_questions` tool: ask, list (`all`, `project`), get (text or decision record), search, update, comment, withdraw, supersede, close, record_answer.
- Duplicate check with `distinctFrom`, a 180-day window for decided items, and near-miss scores in `details`.
- Verbatim answers: user commands, or a quote checked against the session's last 10 interactive inputs.
- User commands `/questions`, `/q`, `/answer`, `/decide`, `/defer`, `/close`; status line (not in subagents).
- Delivery back to the asking session with receipts, lane restart handling, orphan notices, and holds during compaction and handoff.
- `pi-questions` CLI: list, get, ask, wait.
- Multi-user: `answer.by` from `user.json` githubUser, else the OS user; `PI_QUESTIONS_HOME` honoured by extension and CLI.
- Lock-free storage: revision files per item with compare-and-swap writes.
- Delivery holds for compaction and branch summarisation end only with their events; "(delivery held)" in the status line.
- The CLI ships as JavaScript (`dist/`, built on prepack).
- Corrupt or unreadable latest revisions are refused instead of rolled back; id allocation is bounded; simultaneous identical asks both exist and are marked "possible duplicate" when read; supersede moves the superseded item's recipients to the replacement.
