# Standing watches
Format: WATCH|label|until|interval|check
Edit this file in the same turn as any watch change. Re-arm every watch after a reset.

WATCH|{{coordinator}} inbox|success|120|INBOX_DIR={{messages_sh}} "$HOME/.pi/agent/bin/inbox-watch" {{coordinator_sh}}
WATCH|lanes status|change|900|lanes --dir {{root_sh}} status

## On fire: coordinator inbox
Read only new files, act in at most 2 calls or record the pending action, and re-arm. Always relay through a new message file, never an edit.

## On fire: lanes status
Inspect changed lanes, handle blockers or record pending actions, update STATE.md and re-arm. Also verify the inbox watch is armed as a safety net.

## Add your own
Add repository-specific watches and their completion/re-arm actions here. Store transient job ids in STATE.md, not lanes.json.
