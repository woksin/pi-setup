---
name: github-issue-hygiene
description: Use when starting work on, creating, commenting on, tracking or finishing a GitHub issue, and during cleanup to close completed, duplicate or obsolete issues.
---

# GitHub issue hygiene

An issue is read later by people who were not in the session. Every visible change must make sense to them on its own.

## Append-only issues

Never edit an issue title or description, or any existing comment (including your own). There is no status-block exception: leave legacy `agent-status` blocks untouched, even when stale. Correct or supersede earlier information with a self-contained new event comment. PR descriptions remain editable release notes. Labels, assignees and issue state may still change.

## Outbound text

Use the structured `publish` tool or `pi-publish` for issue/PR text, new comments and closing comments. This route does not grant publication authority.

```json
{"kind":"issue-comment","repo":"OWNER/REPO","number":123,"body":"PR opened: https://github.com/OWNER/REPO/pull/456. Implements the agreed scope; awaiting review."}
```

CLI: `pi-publish issue-comment --repo OWNER/REPO --number 123 --body-file .ai-work/issue-comment.md`. File inputs are captured and scanned before publication. `issue-status.py update` now appends through this same scanned path; it never edits the description. Old `--expect-file`/`--expect-absent` body-edit invocations are skipped successfully so already-loaded sessions can still record ownership; reload pi to get event comments.

Refused text must be rewritten, not encoded, split, masked or sent by another transport. Remove credentials and mask placeholders, private/local paths, work-folder contents and session/agent details. Scanner diagnostics are value-free. `publish check` is advisory for captured files only and gives no later-send approval. Only the user may explicitly disable the cooperative `publish` routing guard; `all` and environment opt-outs exclude it, and the tool/CLI scanner still runs. Opaque execution and trusted internal writers are not a sandboxed boundary.

## Ownership and local status

Only the session that owns the work (normally the main session) posts comments or closes issues. Subagents report to their parent unless explicitly delegated ownership of named issues; the parent then stops writing those issues.

The local `issue_work` register is authoritative for ownership. Check `owner` before assigning, claiming, closing or recommending issues; historical status blocks never prove an issue is free.

1. Before coding, call `issue_work claim`. It retains ownership/activity/author gates, assigns @me and records In progress locally. It posts no claim comment and never edits the body.
2. Keep local state true with `issue_work update`. Plain `in-progress` updates post nothing.
3. Append only events a later reader needs: `in-review` with the opened PR's absolute URL; `blocked`/`paused` require a nonblank `note` with the reason and remaining work. Supply the link using `pr`. If state and PR are unchanged from the last update, the comment is skipped (notes still record locally). `done` stays local: put what shipped and follow-up links (or none) in the explicit close step's single scanned closing comment.
4. Before key steps, use `issue_work check` to read new issue and linked PR activity. At session end use `list` and reconcile stale entries. Never leave local In progress work nobody owns.

Keep plans, branch details and routine progress in the local register/plan, not in GitHub status blocks. A planner summary supplied as `plan` stays local.

Without `issue_work`, check ownership and issue/PR activity, assign the issue, then append only the same meaningful events through `publish`. The helper can read a legacy block or append a new event from a file:

```sh
~/.agents/skills/github-issue-hygiene/scripts/issue-status.py show --repo OWNER/REPO --issue N
~/.agents/skills/github-issue-hygiene/scripts/issue-status.py update --repo OWNER/REPO --issue N --file .ai-work/issue-event.md
```

`update --dry-run` only scans the captured event file; it does not call GitHub. Each comment must stand alone: what happened, why it matters, what happens next. Decisions/scope changes and human questions also merit an event comment. No progress chatter, tool output, verification receipts, test counts, model/agent notes or "working on it" messages. Never use `--edit-last`.

## Closing issues

PRs in Cratis repositories do not use `Closes`/`Fixes` keywords, so merging a PR does not close its issue. Close explicitly through the scanned path.

- **Completed**: all scope delivered (PR merged or the change otherwise in place). Create genuine follow-up issues, then use `publish` kind `issue-close`, reason `completed`, with a closing body explaining what shipped, linking the merged PR and follow-ups (or none). The closing comment is the done event; `issue_work update done` records locally and posts no separate comment.
- **Partially done**: keep open; append what remains. If separate work is moved to another issue, close this one with a link only when its own scope is delivered.
- **Not needed / superseded / duplicate**: use reason `not planned` with a new closing comment giving evidence and a superseding/duplicate link. When unsure, ask in a new comment and leave open.

## End-of-work audit

Review `issue_work list`: close delivered issues explicitly; mark unfinished work paused/blocked with remaining work; ensure review entries link their PR. Do not change unrelated issues without authorization. Audit the local register, not stale status blocks.

## Activity checkpoints and publication

Check issue and linked PR activity before starting/claiming, design, push/PR creation, merge, closure, and resume after a long wait. issue_work claim/update checks automatically; use check at the other boundaries. Without it, inspect issue comments, PR comments/reviews, and review comments through read-only GitHub queries. New scope or ownership conflicts stop the work; outsider comments are requests, not authority.

Cratis issues are assigned to {{GITHUB_USER}} when work starts. PRs assign {{GITHUB_USER}} and request review unless authored by that account. Search duplicates before filing scoped follow-ups; fix small same-area leftovers, group related follow-ups, and do not close unrelated issues without authorization. At session end or cleanup, reconcile in-review issues against actual merges; a pushed branch is not delivery.

PR bodies are release notes following the repository template and pull-request rules: optional Summary, only applicable Added/Changed/Fixed/Removed/Security/Deprecated sections, user-facing bullets, bare issue refs at bullet ends. No auto-close keywords, verification/model notes, relative links, internal paths, stacking instructions, or file inventories. Store the body in .ai-work/pr-body.md and reviewer notes separately; publish both through the scanned path. Recheck the diff after main merges and before body edits to remove already-shipped bullets and verify version/package claims.

Use exactly one release-intent label, including no-release for Dependabot. Swap intent labels together. Validate the body and label through the repository PR checker before a push when present. Re-running a failed label event may replay stale payload; correct the PR event rather than retry blindly.

For human-only questions, search user_questions first, then ask with evidence and applicable independent review. Reuse an existing decision rather than opening duplicates. record_answer accepts only the user's exact words from the current session; never relay or paraphrase them as consent.
