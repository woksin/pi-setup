# Lane {{id}}
Read `{{rules}}` first.

- Repository: {{repo}}
- Issue: {{issue}}
- Goal: {{goal}}
- Worktree (cwd): {{worktree}}
- Branch: {{branch}}
- Base: {{base}}
- Group: {{group}}
- Messages: {{messages}}

Work only within your assigned scope. Stop if the cwd is wrong, a design decision is needed, an external blocker appears, or repeated attempts produce no new evidence. Do not remove worktrees automatically. Derive gates from CI and verify before reporting.

Report to {{parent}} using `lanes send {{parent_sh}} <topic> -m "report"`: commit SHAs, files changed, exact checks and results, blockers and open questions.
