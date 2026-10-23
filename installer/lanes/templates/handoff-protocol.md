# Handoff protocol
Keep NOW.md current with in-flight work, owners, completion actions and open asks. Keep STATE.md current with lane states, merge order, decisions and pending actions. Record a multi-step pending action before starting it; remove it only when complete.

## Before a handoff
Update NOW.md and STATE.md. Verify each watch is live against WATCHES.md; re-arm missing watches and handle unread inbox files. The context_handoff must contain verified facts with check times and SHAs, next action, all running jobs/watches with ids and re-arm commands, pending replies, open questions, files to read, and user constraints verbatim. Separate hypotheses from facts.

## After a reset
Read NOW.md, STATE.md, WATCHES.md and this protocol. Re-arm missing watches first, especially the inbox. Handle unread messages. Re-verify every fact before acting: a handoff is a claim, not fresh evidence.

## Relaying
Always send a new file with `lanes send`; never edit old messages. Record undelivered asks in STATE.md. Never type into a stopped or unrelated session.

## Inbox safety net
Each status watch must also check that the inbox watch is live. Every handoff includes its verified job id and exact re-arm command. A timeout with no new message only needs a re-arm.
