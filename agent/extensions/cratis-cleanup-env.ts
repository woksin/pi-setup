import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Stop the Cratis AI worktree cleanup hook (`cratis-cleanup-worktrees.sh --hook`) from
// asking GitHub about every worktree. It runs `gh pr list` once per worktree after each
// git merge/pull/worktree command and at session start, and on 2026-10-24 that drained
// the shared GraphQL quota (Cratis/AI#894). With CRATIS_CLEANUP_NO_GH=1 the hook still
// removes worktrees whose branch git ancestry shows as merged; it only skips the
// squash-merge lookup on GitHub. Child processes (bash tool, git hooks) inherit it.
// An explicit value (e.g. CRATIS_CLEANUP_NO_GH=0) still wins.
export default function (_pi: ExtensionAPI) {
  if (process.env.CRATIS_CLEANUP_NO_GH === undefined) process.env.CRATIS_CLEANUP_NO_GH = "1";
}
