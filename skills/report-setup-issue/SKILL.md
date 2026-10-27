---
name: report-setup-issue
description: Use when a reproducible defect or misleading output comes from the pi setup, its bundled tools, skills, guards, profiles or packages, rather than project code or user error.
license: MIT
compatibility: Pi setup checkout and GitHub CLI (gh) authenticated for issue searches and reports.
---

# Report setup problems to their owner

Report reproducible setup defects and misleading output instead of silently working
around them. Do not report ordinary user error, missing logins, expected guard
refusals or bugs in the user's project. Never patch the live install silently or
disable a guard to reproduce a problem. If ownership or reproduction is unclear,
ask the user before filing.

## Find the owner

For a file under `~/.pi/agent/`, remove that prefix and look under `agent/` in the
pi-setup checkout (for example, `extensions/` or `bin/`). Files under
`~/.agents/skills/<name>/` come from `skills/<name>/` when bundled here. Check the
installer's `.pi-setup/manifest.json` and the checkout before assuming a local or
third-party file belongs to this setup. For npm packages, read the installed
`package.json` `repository` field; do not infer ownership from an extension name.

The map below comes from README's Related repositories and the `repository.url`
metadata for the dependencies in `agent/npm-package.json` (including pi):

| Component (`report --component` name) | Repository |
| --- | --- |
| `pi-setup`, installer, `agent/` files, extensions, lib, bin, skills, agents, profiles, pi-questions | `woksin/pi-setup` |
| `pi-jobs` / `@woksin/pi-jobs` | `woksin/pi-jobs` |
| `pi-recover` / `@woksin/pi-recover` | `woksin/pi-recover` |
| `pi-context-budget` / `@woksin/pi-context-budget` | `woksin/pi-context-budget` |
| `pi-orch` / `@woksin/pi-orch` | `woksin/pi-orch` |
| `pi-anthropic-auth` / `@gotgenes/pi-anthropic-auth` | `gotgenes/pi-anthropic-auth` |
| `pi-subagents` / `@tintinweb/pi-subagents` | `tintinweb/pi-subagents` |
| `piolium` / `@vigolium/piolium` | `vigolium/piolium` |
| `donsetch` | `dondai44423/donsetch` |
| `pi-browser-use` | `0xPlayerOne/pi-browser-use` |
| `pi-mcp-adapter` | `nicobailon/pi-mcp-adapter` |
| `pi-web-access` | `nicobailon/pi-web-access` |
| `pi` / `@earendil-works/pi-coding-agent` | `earendil-works/pi` |
| `codescene` (CodeScene MCP and its upstream skills) | `codescene-oss/codescene-mcp-server` |

A configuration mistake in this setup still belongs to `woksin/pi-setup`, not to
the upstream package it configures. Verify repository metadata again if a package
has moved.

## Search, redact, then report

1. Collect a minimal safe reproduction and run `./install.sh report --component
   <name>` from the checkout. It prints local versions and the target repository;
   without `--open` it makes no network calls. Include the affected third-party
   package's installed version from its `package.json` when relevant.
2. Search **before creating anything**, using public, redacted keywords only:
   `gh issue list --repo <owner/repo> --state all --search '<short symptom>'`.
   Read likely matches with `gh issue view <number> --repo <owner/repo>`. If one
   describes the same defect, add only new reproduction/version evidence with
   `gh issue comment <number> --repo <owner/repo> --body-file <redacted-file>`
   instead of opening a duplicate (including when a closed issue still applies).
3. **Authorization:** filing or commenting in `woksin/*` has standing user
   authorization. For third-party/upstream repositories, get the user's explicit
   OK before filing or commenting. Subagents report to their parent; they do not
   file issues themselves. Never treat standing authorization as permission to
   publish private information.
4. Redact secrets, tokens, credentials, personal paths, private repo names and
   session content from the reproduction, searches, commands and output. Use
   placeholders such as `<home>` and `<project>`; do not attach raw logs, auth
   files, environment dumps or session transcripts. Review the final body before
   sending it. If a safe report is impossible, stop and ask the user.
5. File with `gh issue create --repo <owner/repo> --title '<concise symptom>'
   --body-file <redacted-file>`, or let the user review a browser draft with
   `./install.sh report --component <name> --open`. The latter runs
   `gh issue create --repo <target> --web` with a versions template; it is not a
   substitute for the duplicate search or upstream permission.

Use this body (include only the relevant, redacted output excerpt):

```markdown
## What happened
<Reproducible symptom and minimal steps>

## Expected
<Expected behaviour>

## Exact command and output excerpt (redacted)
<Command, exit code and short output excerpt; no session content>

## Versions
<pi-setup release tag or commit, pi version, affected package versions,
Node.js version and OS; use ./install.sh report>
```

Return the issue URL to the user, or explain why reporting is blocked. Any fix
belongs in the owning repository with tests, not in the live setup.
