# Lane-policy local Pi pilot (cooperative guard)

**Dormant by default.** Installing these source files or this README does not enroll a repository. No pilot commands below were executed against live lanes during implementation. Do not reload/activate running lanes without a separate operator decision.

This is a Pi tool-boundary guard, **not** a filesystem/network/process sandbox. It cannot prevent arbitrary scripts outside known enrolled scopes or trusted extensions invoking other tools internally without a model tool event. No child-session authority is inferred from parent metadata.

## Operator controls

`/guards` lists `lane-policy` with the same precedence as other guards: process/session override > persisted `guards.json` > `PI_GUARDS_OFF` > on. A corrupt guard file defaults on (explicit process overrides still win). Persistence changes are reread in other processes.

- `/guards off lane-policy`: deliberately bypass lane-policy enforcement in this process, including policy-path protection, tool decisions and the MCP lane denial. It does **not** grant writer permissions or change policy/ACK state.
- `/guards on lane-policy`: resume enforcement immediately.
- Append `--persist` only if the operator deliberately wants the normal shared persistent guard setting. `all` includes this guard. Never edit `guards.json` to simulate the command.
- Disabling `lane-policy` does **not** bypass the independent `mcp` approval guard. With lane-policy on, `/guards off mcp` cannot bypass an enrolled-scope lane denial.

No guard was disabled in a live session as part of this work; tests use isolated HOME/guard files and process state.

## Policy and revisions

The optional store is `~/.pi/agent/lane-policy/policy.json`. With no file, the policy is revision 0, has no repositories, no bindings/grants/ACKs and **no forbidden-task defaults**. Restrictions exist only after explicit configuration. Malformed/legacy schema fails closed rather than migrating silently. There is no automatic activation or repair.

Repository identity is the canonical common Git directory (shared by worktrees), plus explicit GitHub `owner/repo`. Session identity comes from Pi's session manager. Each binding records a session, lane, branch and actions. Writers are unique per branch/action and must have matching bindings.

Every successful authority mutation increments one **global monotonic policy revision**, including grant creation, revocation and changes to another repository. Grants are reusable for their 1–60 minute TTL, but only at the exact revision where created. A later authority change invalidates all older grants immediately. A new grant is itself a new authority revision; earlier grants become stale. Reissue the exact exception needed last, not a sequence of grants assumed to accumulate across revisions. Multi-action grant batching is not implemented.

`/lane-policy ack <current-revision>` durably records only the invoking bound session/coordinator's acknowledgement for the current repository. It needs explicit operator TUI confirmation, but does not need coordinator reassignment authority. ACK does **not** increment the authority revision, authorize an action, revive a stale grant or require a fresh ACK before an otherwise authorized action. A stale/missing ACK is visibility only.

`/lane-policy status` shows revision, current session/repository, assignments, grants and ACKs. Startup/resume (`session_start`) and compaction refresh the small UI status; `before_agent_start` rereads and appends a bounded current policy summary to the existing system prompt. It exposes missing/current/stale ACK state, without relying on previous chat history. There is no per-turn notification spam or session-authority cache.

Writes use an immediate exclusive lock, compare-and-swap against the bytes parsed before confirmation, a synced temporary file and atomic rename. The directory is synced where the filesystem supports it. ACK-only writes may keep the authority revision; other writes must use the next revision. Locks are not stolen or automatically repaired. After an interrupted writer or invalid store, an operator must inspect the file/lock outside model-facing tools before retrying.

## Explicit isolated pilot procedure (instructions only)

Use a disposable Git repository/worktree and a new operator-controlled Pi session, **not** a live Studio lane. Replace placeholders with session IDs from `/lane-policy status`. Use a non-integration branch. All policy writes require interactive TUI mode and a positive confirmation; RPC/json/print cannot mutate policy. Commands are not registered as model tools.

In the intended coordinator session:

```text
/lane-policy status
/lane-policy bootstrap owner/repo
/lane-policy enroll WRITER_SESSION pilot pilot-branch push,pr-create,issue-write,pr-comment
/lane-policy writer WRITER_SESSION pilot-branch push,pr-create,issue-write,pr-comment
/lane-policy grant WRITER_SESSION push pilot-branch 5 minutes
/lane-policy status
```

In that explicitly bound writer session, inspect `/lane-policy status`, then acknowledge the displayed current revision with `/lane-policy ack N`. A push grant permits only the attributable command shape `git push origin pilot-branch:pilot-branch`. No test here executes publication commands. Exercise allow/deny with fake events or a separate operator-controlled dry pilot before attempting real publication.

Other operator authority commands:

```text
/lane-policy coordinator SESSION_ID
/lane-policy grant WRITER_SESSION pr-create pilot-branch 5 minutes
/lane-policy grant WRITER_SESSION issue-write ISSUE_NUMBER 5 minutes
/lane-policy grant WRITER_SESSION pr-comment PR_NUMBER 5 minutes
/lane-policy forbid owner/repo/#NUMBER
/lane-policy clear-forbidden owner/repo/#NUMBER
/lane-policy revoke grants WRITER_SESSION
/lane-policy revoke writer WRITER_SESSION
/lane-policy revoke session WRITER_SESSION
```

Only the repository coordinator may change authority, unless the operator explicitly appends `--override` and confirms. `revoke writer` also removes the session's grants; `revoke session` removes bindings, writers and grants. Writer conflicts require revoke before reassignment. Configured forbidden targets match an exact case-insensitive `owner/repo/#number`; they are not inferred from unrelated quoted issue numbers.

### Rollback / pause (operator only)

- Safely revoke pilot publication authority with `/lane-policy revoke session WRITER_SESSION` in its coordinator session; this advances the revision and invalidates old exceptions.
- If an availability problem requires bypassing enforcement, the operator can explicitly use `/guards off lane-policy` (process-local) and later `/guards on lane-policy`. This bypass is not a safety-preserving publication revocation; all lane enforcement is off in that process.
- A previously chosen persistent opt-out can be reversed with `/guards on lane-policy --persist`; other process-local overrides still take precedence. Do not automatically reload lanes, remove policy files, steal locks or edit global settings as rollback.

## Covered surfaces and limits

- Git push: one explicit `origin` refspec with the same non-integration source/destination branch. `HEAD` requires attached branch identity. Origin's exact push URL must match the enrolled GitHub repository; multiple/mismatched URLs are denied. Allowed flags: `-u`, `--set-upstream`, `--force-with-lease`. Deletes, mirror/all/tags, force, wildcards, multiple/different refspecs and integration branches are denied.
- Git targeting: one shared parser handles attached/spaced/repeated `-C` before both scope detection and enforcement. Simple literal `cd` and linked worktrees are supported. Unresolved `-C` and unsupported Git global targeting/configuration options are conservatively denied while any repository is enrolled, including from outside the repository. Recognized Git/GitHub environment overrides are denied as unresolved targeting. This deliberately restricts ambiguous targeting, not all unrelated tools.
- GitHub: direct PR creation with exact `-R owner/repo` and writer branch; numeric issue edits/comments/close/reopen and PR comments with exact repo and numeric target. Each requires the corresponding exact current-revision grant. Read-only enumerated Git/GitHub commands remain available. `gh api`/GraphQL are opaque and denied in known enrolled scope.
- **PR merge and issue creation remain unsupported/deny-only**, even with a reserved `pr-merge` grant. Safe PR-head resolution is not implemented.
- Model `bash`, `user_bash`, supported nested `multi_tool_use`/`multi_tool_use.parallel` `tool_uses` payloads and job command/check/cwd fields are inspected before execution. Unknown/deep nested payloads are conservatively denied when policies exist. Jobs remain opaque/deny-only in known enrolled scope; a command naming an enrolled Git target is still assessed from an otherwise unbound outside session.
- MCP proxy/direct/script/codemode, Agent, SubagentWorkflow and unknown tools are deny-only in known enrolled scope. The MCP broker synchronously attempts `deny` before this extension's `/guards off mcp` bypass. The installed broker is **first claimant wins**: an earlier external claimant cannot be displaced. The outer model `tool_call` denial remains essential. Internal calls made by another trusted extension without that event are not guaranteed covered. No npm adapter changes were made.
- Known scope means current canonical repository, explicit session binding/coordinator, recognized Git/GitHub target, explicit tool cwd, or enrolled repo/common-directory text in opaque payloads. Obfuscated or dynamically constructed targets outside those scopes remain outside reliable attribution. Hooks/config/executable resolution are trusted, not sandboxed.
- Canonical direct model write/edit paths (including symlinks) and visible shell references to the policy directory and implementation/guard sources are protected when this guard is on. Arbitrarily constructed unenrolled scripts can still evade lexical protection. There is no claim of comprehensive cross-process prevention.

## Validation and source history

Relevant unit gate: `node --test ~/.pi/agent/lib/guards.test.ts ~/.pi/agent/lib/lane-policy.test.ts`, invoked through `pi-phase` with bounded queue/execution budgets. Fake-event adapter tests exercise actual registered callbacks, revision/ACK/restart/compaction, named controls, first-claim ordering and direct/nested/job/MCP routes without executing publication tools. Runtime compatibility uses the installed Pi Jiti loader with a fake registration API, not activation of live extensions.

Exact commands/results and review notes live under `/Volumes/sourcecode/repos/cratis/.ai-work/pi-lane-policy/`. `keep/round1-current/` contains exact copies made **after the first implementation and before review fixes**. They are not the original baseline. No genuine original before-state was preserved for the initial implementation, so the original-to-current diff is unverifiable; only the round-one-to-current diff is available. No historical baseline was reconstructed or fabricated.

No local CI package/solution, compiler/formatter or CodeScene tool is available for these loose home-directory Pi files. No CI-equivalent Tier 1/Tier 2, Studio solution build, integration run or production pilot is claimed.
