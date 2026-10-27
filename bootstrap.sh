#!/bin/sh
# Download and verify a released pi-setup archive, then hand off to install.sh.
# curl -fsSL https://github.com/woksin/pi-setup/releases/latest/download/bootstrap.sh | sh
# Pass flags with: ... | sh -s -- --yes --install-prereqs
# PI_SETUP_DIR chooses the destination; PI_SETUP_RELEASES_URL overrides the release base URL.
set -eu

PIN_TAG=""
PIN_SHA256=""

say() { printf 'pi-setup: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

usage() {
  say 'Usage: bootstrap.sh [--dir <path>] [--version <tag>] [installer flags]'
  say 'Installer flags (passed through): --yes --dry-run --plan --install-prereqs --with <id> ...'
  say 'Default directory: ~/pi-setup. Re-run this command to update a bootstrap install.'
}

valid_tag() { printf '%s\n' "$1" | grep -Eq '^v[0-9A-Za-z.-]+$'; }
valid_sha() { printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{64}$'; }

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1" || die "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "download failed: $1"
  else
    die 'needs curl or wget'
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/^.*= //'
  else
    die 'needs sha256sum, shasum or openssl for SHA-256 verification'
  fi
}

resolve_pin() {
  if [ -n "$PIN_TAG" ] && [ -z "$version" ]; then
    tag="$PIN_TAG" sha="$PIN_SHA256"
  else
    if [ -n "$version" ]; then
      sums_url="$RELEASES/download/$version/SHA256SUMS"
    else
      sums_url="$RELEASES/latest/download/SHA256SUMS"
    fi
    fetch "$sums_url" "$tmp/SHA256SUMS"
    count=0
    while read -r checksum filename extra; do
      case "$filename" in
        pi-setup-v*.tar.gz)
          [ -z "$extra" ] || die 'invalid SHA256SUMS'
          count=$((count + 1))
          sha="$checksum"
          tag="${filename#pi-setup-}"
          tag="${tag%.tar.gz}"
          ;;
      esac
    done < "$tmp/SHA256SUMS"
    [ "$count" = 1 ] || die 'expected one pi-setup archive in SHA256SUMS'
    if [ -n "$version" ] && [ "$version" != "$tag" ]; then
      die 'release tag does not match SHA256SUMS'
    fi
  fi
  valid_tag "$tag" || die 'invalid release tag'
  valid_sha "$sha" || die 'invalid SHA-256 checksum'
}

# shellcheck disable=SC2317,SC2329 # invoked through the EXIT trap
cleanup() { rm -rf "$tmp"; }

destination() {
  # Never follow a destination symlink or accept a path naming its parent/root.
  while [ "${DEST%/}" != "$DEST" ]; do DEST="${DEST%/}"; done
  case "$DEST" in ''|.|..|*/.|*/..) die 'unsafe install directory' ;; esac
  case "$DEST" in /*) ;; *) DEST="$PWD/$DEST" ;; esac
  [ ! -L "$DEST" ] || die 'refusing a symlink install directory'
  if [ -e "$DEST/.git" ] || [ -L "$DEST/.git" ]; then
    die 'destination is a git checkout; run ./install.sh update there'
  fi
  if [ -e "$DEST" ]; then
    [ -d "$DEST" ] || die 'destination is not a directory'
    if [ -f "$DEST/.pi-setup-release" ] && [ ! -L "$DEST/.pi-setup-release" ]; then
      owned=1
    else
      owned=0
      for entry in "$DEST"/* "$DEST"/.[!.]* "$DEST"/..?*; do
        if [ -e "$entry" ] || [ -L "$entry" ]; then
          die 'destination is not empty and was not created by bootstrap'
        fi
      done
    fi
  else
    owned=0
  fi
  printf '%s\n' "$tag" > "$tree/.pi-setup-release"
  mkdir -p "$(dirname "$DEST")"
  if [ "$owned" = 1 ]; then
    rm -rf "$DEST"
  elif [ -d "$DEST" ]; then
    rmdir "$DEST"
  fi
  mv "$tree" "$DEST"
}

handoff() {
  cd "$1"
  shift
  # curl | sh owns stdin; reopen the controlling terminal for the guided installer.
  # Host unit tests cover /dev/null; a real terminal is needed for this branch.
  if [ "$yes" = 0 ] && [ "$dry" = 0 ] && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
    if sh ./install.sh "$@" </dev/tty; then code=0; else code=$?; fi
  else
    if sh ./install.sh "$@" </dev/null; then code=0; else code=$?; fi
  fi
}

main() {
  RELEASES="${PI_SETUP_RELEASES_URL:-https://github.com/woksin/pi-setup/releases}"
  DEST="${PI_SETUP_DIR:-$HOME/pi-setup}"
  version='' pending='' pass_value=0 dry=0 yes=0
  # Rebuild the positional arguments without arrays, preserving values and order.
  for arg do
    shift
    if [ -n "$pending" ]; then
      case "$arg" in ''|-*) die "Missing value for $pending" ;; esac
      case "$pending" in --dir) DEST="$arg" ;; --version) version="$arg" ;; esac
      pending=''
    elif [ "$pass_value" = 1 ]; then
      set -- "$@" "$arg"
      pass_value=0
    else
      case "$arg" in
        --dir|--version) pending="$arg" ;;
        --help|-h) usage; return 0 ;;
        --dry-run|--plan) dry=1; set -- "$@" "$arg" ;;
        --yes) yes=1; set -- "$@" "$arg" ;;
        --user|--repos-root|--profile|--ref|--keep|--with|--without)
          pass_value=1; set -- "$@" "$arg" ;;
        *) set -- "$@" "$arg" ;;
      esac
    fi
  done
  [ -z "$pending" ] || die "Missing value for $pending"
  if [ -n "$version" ]; then valid_tag "$version" || die 'invalid release tag'; fi
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) die 'pi-setup does not run in a native Windows shell: use WSL2 (https://learn.microsoft.com/windows/wsl/install), then run this command inside it.' ;;
  esac
  tmp="$(mktemp -d)"
  trap cleanup 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  resolve_pin
  fetch "$RELEASES/download/$tag/pi-setup-$tag.tar.gz" "$tmp/release.tar.gz"
  actual="$(sha256 "$tmp/release.tar.gz")"
  [ "$actual" = "$sha" ] || die 'checksum mismatch; nothing was installed'
  tar -xzf "$tmp/release.tar.gz" -C "$tmp"
  tree="$tmp/pi-setup-$tag"
  [ -f "$tree/install.sh" ] || die 'release archive has no install.sh'
  if [ "$dry" = 1 ]; then
    handoff "$tree" "$@"
    say 'Next: run the same command without --dry-run.'
  else
    destination
    handoff "$DEST" "$@"
    say "pi-setup is in $DEST: run ./install.sh doctor, update or uninstall there. To update, run the same curl command again."
  fi
  exit "$code"
}

main "$@"
