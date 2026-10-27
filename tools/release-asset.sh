#!/bin/sh
# Build uploaded release assets, or render a tag/checksum-pinned bootstrap.
# build <tag> <outdir> [<tree-ish>] (defaults to <tag>)
# PI_SETUP_BOOTSTRAP_SRC optionally supplies the bootstrap template for older tags.
# render <tag> <sha256> <in> <out>
set -eu

say() { printf 'pi-setup: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }
valid_tag() { printf '%s\n' "$1" | grep -Eq '^v[0-9A-Za-z.-]+$'; }
valid_sha() { printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{64}$'; }

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

render() {
  tag="$1" sha="$2" source="$3" output="$4"
  valid_tag "$tag" || die 'invalid release tag'
  valid_sha "$sha" || die 'invalid SHA-256 checksum'
  [ "$(grep -c '^PIN_TAG=""$' "$source")" = 1 ] || die 'expected one PIN_TAG marker'
  [ "$(grep -c '^PIN_SHA256=""$' "$source")" = 1 ] || die 'expected one PIN_SHA256 marker'
  sed -e "s/^PIN_TAG=\"\"$/PIN_TAG=\"$tag\"/" \
      -e "s/^PIN_SHA256=\"\"$/PIN_SHA256=\"$sha\"/" "$source" > "$output"
  chmod 755 "$output"
}

# shellcheck disable=SC2317,SC2329 # invoked through the EXIT trap
cleanup() { rm -rf "$tmp"; }

build() {
  tag="$1" out="$2" ref="${3:-$1}"
  valid_tag "$tag" || die 'invalid release tag'
  tmp="$(mktemp -d)"
  trap cleanup 0
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -p "$out"
  # Separate commands preserve git archive's failure status in POSIX sh.
  git archive --format=tar --prefix="pi-setup-$tag/" "$ref" > "$tmp/archive.tar"
  gzip -n -9 < "$tmp/archive.tar" > "$out/pi-setup-$tag.tar.gz"
  sha="$(sha256 "$out/pi-setup-$tag.tar.gz")"
  valid_sha "$sha" || die 'invalid SHA-256 checksum'
  printf '%s  pi-setup-%s.tar.gz\n' "$sha" "$tag" > "$out/SHA256SUMS"
  if [ -n "${PI_SETUP_BOOTSTRAP_SRC:-}" ]; then
    source="$PI_SETUP_BOOTSTRAP_SRC"
  else
    git show "$ref:bootstrap.sh" > "$tmp/bootstrap.sh"
    source="$tmp/bootstrap.sh"
  fi
  render "$tag" "$sha" "$source" "$out/bootstrap.sh"
}

main() {
  case "${1:-}" in
    build)
      shift
      if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then die 'Usage: release-asset.sh build <tag> <outdir> [<tree-ish>]'; fi
      build "$@"
      ;;
    render)
      shift
      [ "$#" = 4 ] || die 'Usage: release-asset.sh render <tag> <sha256> <in> <out>'
      render "$@"
      ;;
    *) die 'Usage: release-asset.sh build|render ...' ;;
  esac
}

main "$@"
