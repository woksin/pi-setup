#!/usr/bin/env bash
# Host side of the first-time-install acceptance test: a clean Ubuntu container, a normal user with sudo, no Node.
# Needs docker. Packs the working tree (no .git), runs inside.sh in a --rm container, with a deadline.
# Usage: bash tests/container/run.sh        (PI_SETUP_CONTAINER_DEADLINE=<seconds>, default 1500)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
command -v docker >/dev/null 2>&1 || { echo "docker is required for the container test" >&2; exit 2; }

tmp="$(mktemp -d)"
name="pi-setup-container-$$"
watchdog=""
# shellcheck disable=SC2317,SC2329 # invoked through the EXIT trap
cleanup() {
  if [ -n "$watchdog" ]; then kill "$watchdog" 2>/dev/null || true; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# The tracked files; the worktree's .git is a file and would break inside the container.
# Tracked files only, and no macOS AppleDouble (._*) entries in the archive.
(cd "$repo" && COPYFILE_DISABLE=1 git ls-files -c -z | COPYFILE_DISABLE=1 tar --null -T - -czf "$tmp/src.tgz")
cp "$here/inside.sh" "$here/assert-doctor.py" "$tmp/"

deadline="${PI_SETUP_CONTAINER_DEADLINE:-1500}"
fired="$tmp/deadline-fired"
(sleep "$deadline"; : > "$fired"; docker kill "$name" >/dev/null 2>&1) &
watchdog=$!

set +e
docker run --rm --name "$name" -v "$tmp":/in:ro ubuntu:24.04 sh /in/inside.sh
code=$?
set -e
if [ -e "$fired" ]; then echo "deadline exceeded (${deadline}s): container killed" >&2; exit 124; fi
exit "$code"
