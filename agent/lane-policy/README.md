# Lane-policy local Pi pilot (cooperative guard)

**Dormant by default.** Installing these source files or this README does not enroll a repository. No pilot commands below were executed against live lanes during implementation. Do not reload/activate running lanes without a separate operator decision.

This is a Pi tool-boundary guard, **not** a filesystem/network/process sandbox. It cannot prevent arbitrary scripts outside known enrolled scopes or trusted extensions invoking other tools internally without a model tool event. No child-session authority is inferred from parent metadata.

## Operator controls

`/guards` lists `lane-policy` with the same precedence as other guards: process/session override > persisted `guards.json` > `PI_GUARDS_OFF` > on. A corrupt guard file defaults on (explicit process overrides still win). Persistence changes are reread in other processes.

- `/guards off lane-policy`: deliberately bypass lane-policy enforcement in this process, including policy-path protection, tool decisions and the MCP lane denial. It does **not** grant writer permissions or change policy/ACK state.
- `/guards on lane-policy`: resume enforcement immediately.
- Append `--persist` only if the operator deliberately wants the normal shared persistent guard setting. `all` includes this guard. Never edit `guards.json` to simulate the command.
- Disabling `lane-policy` does **not** bypass the independent `mcp` approval guard. With lane-policy on, `/guards off mcp` cannot bypass an identified enrolled-scope GitHub-write denial.

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

## Publication-only boundary and limits

**Ordinary work is allowed in enrolled lanes, including sessions with no binding.** `dotnet build/test`, yarn/npm, node/python, ordinary scripts, local Git work, shell/eval, env wrappers, `pi-phase`, redirection and tools without publication tokens are not blanket-blocked. Normal MCP tools, `Agent`, `SubagentWorkflow`, jobs and unknown tools remain available. An unreadable policy blocks visible publication/tampering, not unrelated builds or delegation.

- Git push remains gated by exact repository, writer binding, branch/action and current-revision expiring grant. One explicit origin refspec must have the same non-integration source/destination. Attached/spaced/repeated `git -C` share a parser. Any other Git subcommand carrying `push`, `send-pack` or `http-push` is deny-only, with **only exact `git stash push` exempt**. This also blocks subtree/LFS publication and can conservatively reject innocent arguments containing those tokens. Writing Git aliases, `remote.*.pushurl` or `url.*.pushInsteadOf` is publication setup and gated; existing implicit/specified config reads are not writes. Ordinary commit/merge/fetch/rebase/branch/worktree without publication tokens remain allowed. Unsupported targeting, environment/cwd/expansion/redirection on a publication command is denied.
- In enrolled scope, **gh is deny-by-default with a read-verb allowlist**, not a mutation denylist. Allowed: `pr/issue/run/release/workflow/repo` with `view/list/status/diff/checks/watch`; `search`; `auth status`; REST `api` with an explicit `-X GET`/`--method GET` and no body/fields. All other/unknown verbs, aliases, repo sync/edit/delete, secret/variable/extension operations are publication. Direct PR create, supported numeric issue writes and PR comments retain their existing exact scoped grants and explicit `-R owner/repo`; unsupported publication has no grant action and hands off. **All GraphQL is treated as mutation**, including apparent reads, explicit GET and file queries. `--input` is always mutation; `-f/-F/--field/--raw-field` without explicit GET are mutation, and API fields/bodies with GET are also outside the read allowlist. Implicit-method REST is not allowlisted.
- **PR merge remains deny-only** and explicitly hands off to the train writer/operator. Issue creation, unsupported PR mutations, raw API/GraphQL mutations, release/workflow/run writes have no new grant action in this bounded slice: they are deny-only with operator handoff, not silently authorized under a broader grant. Existing action schema is unchanged.
- Opaque execution is **lexical and cooperative**, not an interpreter/sandbox. Visible publication tokens in sh/bash/eval/node/python/script/phase wrappers are assessed, not a reason to ban the executable itself. Literal shell/eval publication payloads can use attributable direct-command grants. Opaque code containing publication tokens that cannot be attributed is denied with handoff. Dynamically assembled tokens, on-disk script contents, pre-existing hooks/config/aliases and trusted internal extension calls are not comprehensively inspected. Visible `gh` tokens in opaque code are conservative publication candidates; literal attributable shell reads can still use the read allowlist. An innocent opaque argument containing the word `push` can be a conservative false positive. Quoted incidental `echo`/`printf` text is not treated as execution.
- `job_start`/`job_watch` command/check/cwd fields use the same command assessor; ordinary jobs are allowed and publication is gated. Known nested `multi_tool_use` tool payloads are inspected. Unsupported nested shapes are assessed lexically rather than blanket-denied.
- **Delegation does not inherit publication authority.** A child that loads these guards may build/test/read normally, but an unbound child has no writer binding/grant and cannot publish merely by declaring a parent session ID. Launching a child is allowed; loading these extensions into every external child runtime is outside this cooperative boundary. Runtime pilot child cases use a separate real SDK session identity, not the installed Agent launcher/package lifecycle.
- MCP is no longer denied by enrollment alone. Only capability names/server metadata indicating GitHub write operations trigger deny-only lane gating. GitHub reads and all non-GitHub MCP tools remain unaffected by this guard; the independent MCP approval guard and user-approval requirements still apply. Opaque scripts or tools that hide a GitHub mutation behind unrelated names are outside reliable attribution. The synchronous first-claim broker limitation remains: an earlier claimant cannot be displaced, so outer tool_call denial is essential for identified GitHub writes.
- Canonical direct model policy/source writes (including symlink paths), the lane-policy directory and **`~/.pi/agent/guards.json`** are protected before or after enrollment. Shell references to those authority paths are read-only: only readers (cat/head/tail/wc/stat/ls/grep/rg/echo/printf/pwd/readlink/jq/diff/cmp/shasum/sha256sum/md5/file/sort/uniq/cut) are allowlisted, and output redirection is allowed only to `/dev/null`, fd duplication (`2>&1`, `>&2`) or a literal destination under a `.ai-work/` directory (no `..`, no expansion). `tee` and `cp` may write only into `.ai-work/`; `mkdir`/`touch`/`mv`/`cd` are allowed when no operand is an authority path. A mention that appears only in a heredoc body or comment (for example a lane message written with `cat > .ai-work/.../messages/x.md <<'EOF'` that names the policy file) is data and is allowed, unless another command in the line could execute it (shells, interpreters, pipes into them). Unknown writers, links, downloads, interpreters and patches are denied structurally rather than by a write-verb list. Reading through the direct read tool is unchanged. Operator `/guards` and `/lane-policy` writes remain authorized. Arbitrarily constructed paths/scripts can evade lexical detection; there is no filesystem sandbox.

Publication denials include the current revision and designated writer/lane when resolvable, with `send branch+SHA to <writer lane>` handoff. Unknown/unsupported actions identify the operator/coordinator instead of inventing a writer grant. Guard off/on, policy revisions, ACK visibility, CAS and authority commands are unchanged.

## Validation and source history

Relevant unit gate: `node --test ~/.pi/agent/lib/guards.test.ts ~/.pi/agent/lib/lane-policy.test.ts`, invoked through `pi-phase` with bounded queue/execution budgets. Unit adapter tests exercise actual registered callbacks, revision/ACK/restart/compaction, named controls, first-claim ordering, ordinary-work allowances and direct/nested/job/MCP publication gates without executing publication tools. The isolated SDK pilot uses real installed SDK sessions, native Bash execution and nested SDK dispatch; model responses, confirmations, publication executables and the job worker implementation are simulated. It does not validate the installed background job scheduler or Agent package lifecycle, and never activates live extensions.

Exact commands/results and review notes live under the author's local notes directory (not published). `keep/round1-current/` contains exact copies made **after the first implementation and before review fixes**. They are not the original baseline. No genuine original before-state was preserved for the initial implementation, so the original-to-current diff is unverifiable; only labeled post-implementation diffs are available. `keep/round2-current/` preserves the accepted pre-usability sources and pilot; `keep/round3-current/` preserves the exact sources/pilot before the structural review-cap fix. These are labeled current-state copies, not an original baseline. No historical baseline was reconstructed or fabricated.

No local CI package/solution, compiler/formatter or CodeScene tool is available for these loose home-directory Pi files. No CI-equivalent Tier 1/Tier 2, Studio solution build, integration run or production pilot is claimed.
