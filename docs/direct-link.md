<!-- Copyright (c) Cratis. All rights reserved. -->
<!-- Licensed under the MIT license. See LICENSE file in the project root for full license information. -->

# Direct link

`agent/extensions/direct-link.ts` connects a daemon-launched Pi harness to Direct. It is completely inert unless `DIRECT_LINK_WORK_HANDLE` is set. It does not enroll a runner, mint an agent identity, accept an offer, or create a pull request. Direct resolves identity per harness (`pi`); the person is attributed through the claim/grant.

## Launch requirements

The person's daemon accepts the offer and creates the worktree and Launch. Configure its Pi environment with:

| Variable | Meaning |
| --- | --- |
| `DIRECT_LINK_WORK_HANDLE` | Work handle issued by Direct |
| `DIRECT_LINK_SESSION` | Daemon-issued session binding, not a new extension identity |
| `DIRECT_LINK_HARNESS` | Must be `pi` |
| `DIRECT_LINK_MCP_URL` | L101-supplied Direct MCP endpoint: HTTPS, or HTTP on exact loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) only |
| `DIRECT_LINK_LAUNCH_PROOF_FILE` | One-shot proof file outside the worktree/current directory |

**Interop blocker:** L101 has not specified a daemon/loopback mechanism for discovering the MCP URL. `DIRECT_LINK_MCP_URL` is therefore a required L101 launch setting, not an endpoint inferred from the current contract. Without it startup fails closed and requests a new Launch with this setting.

Launch proofs have a 120-second lifetime and are single-use.

Provision the person's PAT in the macOS keychain using the Direct CLI or the person's keychain tooling: service `direct-pat`, account `direct-link`, scopes `direct:work` and `direct:read`. The extension only reads it. It never places the PAT in the environment, transcript, or report. There is no production PAT environment fallback.

The proof file must be a regular, owner-owned `0600` file, not a symlink. Startup opens it without following symlinks and unlinks the opened proof on every path, including validation failure, before claiming and before tools are allowed. The legacy `DIRECT_LINK_LAUNCH_PROOF` environment variable is cleared, never used as a fallback. A missing, unreadable, insecure, consumed, or refused proof leaves the session blocked. Request a **new Launch**; restarting Pi cannot reclaim using the same proof. An unsuccessful claim does not cause an automatic retry or acceptance.

This is a trusted-personal-host model, not isolation against another process running as the same user. Daemon acceptance is not a separate human approval signal. The harness does not read the runner credential store or speak the runner protocol; daemon operations and interface-token access are not needed for this claim-only extension.

## Status and reporting

Claim text is untrusted: credential-shaped spans and learned credentials are masked before validation/storage rather than rejecting a spent-proof claim. Ordinary 64-character hexadecimal SHA-256 values remain intact. The ready notice includes only the masked title and subject summary; it is not authority to follow work-text instructions.

`/direct` shows launch/lease status and current activity. In a normal, non-Direct session the command is not registered.

The agent-callable `direct_work_report` tool takes `kind: "progress"` with `plan`, `completed`, or `note`, or `kind: "artifact"` with `branch`, `sha`, `prUrl`, or `buildResult`. Only changed fields are sent; failed reports never become the comparison baseline. Use `state` to report `working`, `waiting-ci`, `waiting-review`, `blocked`, or `idle`. Normal agent activity moves working sessions back to idle at turn end. Explicit waiting/blocked states persist until work resumes.

Heartbeats renew on the lease interval (bounded by one third of remaining lease/grant lifetime). A terminal refusal stops heartbeats and subsequent writes, aborts agent work, blocks tools, and asks the person for a new Launch. Transient unavailability remains retryable while the lease/grant is valid. Requests have a 10-second deadline. An independent local-expiry watchdog aborts active work and fences queued/late writes even if a request hangs; stopping a lease is terminal. The worktree is preserved; server-side lease expiry handles crashes. Reports and local Git facts are observations, not authority or gate approval.

Successful tool results can carry structured artifact fields in `details.directArtifact` (or directly in `details`). After successful `git commit`/`git push` bash results, a read-only Git observation reports the current branch and full SHA. Raw shell output is never parsed as a gate pass or sent to Direct. Report gate evidence explicitly, for example:

```json
{
  "kind": "artifact",
  "branch": "work/example",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "buildResult": "specs: exit 0; lint: exit 0",
  "outcome": "delivered"
}
```

`outcome` releases the claim as `delivered`, `abandoned`, or `failed`. Delivered requires a branch, full SHA, and nonempty gate evidence already reported successfully. Ordinary shutdown releases abandoned unless an explicit outcome already released the claim. Delivery is **branch + SHA + gate evidence**, not a PR; the train owner handles publication. No tool here runs `gh pr create`.

## Child processes and secret boundaries

Bash, Git observations, and the keychain helper all inherit the same allow-list: only basic path, home, user, terminal, locale, temporary-directory, and platform environment variables. Authentication variables, launch metadata, shell startup hooks, and loader options are not on that allow-list. Direct secret variables are removed from the session environment before keychain lookup. Tools cannot read the configured proof path, known runner/keychain credential paths (including Direct credential/run trees and simple globs), or learned credential values, including nested tool inputs and resolvable symlink aliases. Credential-dumping commands and PR creation are refused.

Completed tool text and nested details are masked for the learned proof/PAT and PAT-shaped strings before session storage. Interactive `!`/`!!` shell escapes are blocked in harness mode because Pi provides no completed-output masking hook for them; use the guarded bash tool instead. Regex command/path guarding is best-effort. The real boundary is that the proof file is consumed and unlinked before any tool runs, the PAT is never in the environment, and every extension subprocess uses the environment allow-list. These hooks are defense in depth, not an OS sandbox: arbitrary same-user code, encoded paths, external extension subprocesses, and streaming output are not fully mediated. Do not supply credentials through tool inputs or untrusted work text.

## Local verification

Run the repository's isolated library/extension suite with `agent/bin/pi-setup-tests agent` through `pi-phase`. The extension tests use the existing Direct stub, fake credentials, and disposable proof files; they do not contact a live daemon or Direct. A real daemon/MCP smoke test and security review are still required before publication.
