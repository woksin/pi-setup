# Standing watches
Format: WATCH|label|until|interval|check
Edit this file in the same turn as any watch change. Re-arm active watches after a reset; parked lanes intentionally have no replacement inbox watch.

WATCH|{{coordinator}} inbox|success|120|INBOX_DIR={{messages_sh}} "$HOME/.pi/agent/bin/inbox-watch" {{coordinator_sh}}
WATCH|lanes status|change|900|lanes --dir {{root_sh}} status
WATCH|idle lanes|success|900|lanes --dir {{root_sh}} idle-check
# WATCH|green PRs|success|600|lanes --dir {{root_sh}} green-prs --new
After handling green PRs, ack with `lanes --dir {{root_sh}} green-prs --ack`.

## On fire: coordinator inbox
Only send actionable coordination: deliveries, blocker changes, questions/decisions or new relevant safety holds. No unchanged status, ACK-of-ACK or cc messages. ALL is reserved for truly global safety holds; keep targeted critical alerts.
Read only new files, act in at most 2 calls or record the pending action, and re-arm. Acknowledge action-needed deliveries and questions to the named owner only, not information-only or ALL/FYI messages. Always relay through a new message file, never an edit.

## Parking
Write a compact owner/dependency/assessment handoff, set `lane-status set <ID> parked "dependency / owner" --until +90m`, cancel the inbox watch and obsolete waits, then settle. Assessment never wakes the worker. The coordinator explicitly sets working/resumes when actionable; a live parked primary still occupies its admission slot.

## On timeout
For active lanes, re-arm silently. Renew waiting-on leases locally without messaging. Notify once on blocking, then only on material state change, lease expiry or explicit request; no hourly "still waiting" messages.

## On fire: lanes status
Inspect changed lanes, handle blockers or record pending actions, update STATE.md and re-arm. Also verify the inbox watch is armed as a safety net.

## Add your own
Add repository-specific watches and their completion/re-arm actions here. Store transient job ids in STATE.md, not lanes.json.
