#!/bin/sh
# Node-free preflight for install.sh: makes sure Node.js >= 22.19 exists before the Node installer starts.
# Sourced by install.sh; POSIX sh only (it runs before any Node does). Everything it says goes to stderr.
# Real utilities it uses: uname id cat mkdir ln rm grep sed tr cut head dirname tar mktemp chmod (+ curl, sha256sum or shasum, sudo, brew, apt-get, dnf when needed)

PS_NODE_MAJOR_URL="https://nodejs.org/dist/latest-v24.x"
# Where Homebrew and the official Node installer put things; tests point this at an empty directory.
PS_SYSTEM_DIRS="${PI_SETUP_SYSTEM_BIN_DIRS:-/opt/homebrew/bin /usr/local/bin}"
PS_BREW_INSTALLER="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

ps_say() { printf '%s\n' "$*" >&2; }
ps_die() { ps_say "$*"; exit 1; }

ps_node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' >/dev/null 2>&1
}

# Scan the arguments; they all pass through to Node unchanged.
ps_scan() {
  PS_DRY=0 PS_YES=0 PS_JSON=0 PS_SKIP_NPM=0 PS_CONSENT="" PS_CMD="install"
  for ps_arg in "$@"; do
    case "$ps_arg" in
      --dry-run|--plan) PS_DRY=1 ;;
      --yes) PS_YES=1 ;;
      --json) PS_JSON=1 ;;
      --skip-npm) PS_SKIP_NPM=1 ;;
      --install-prereqs) PS_CONSENT="yes" ;;
      --no-install-prereqs) PS_CONSENT="no" ;;
      -*) ;;
      *) [ "$PS_CMD" = "install" ] && PS_CMD="$ps_arg" ;;
    esac
  done
  PS_INTERACTIVE=0
  if [ -t 0 ] && [ -t 1 ] && [ -z "${CI:-}" ] && [ "$PS_YES" = 0 ] && [ "$PS_JSON" = 0 ] && [ "$PS_DRY" = 0 ]; then PS_INTERACTIVE=1; fi
}

# A fresh machine: no pi-setup manifest and no ~/.pi/agent yet.
ps_fresh() { [ ! -e "$HOME/.pi/agent" ] && [ ! -e "$HOME/.pi/agent/.pi-setup/manifest.json" ]; }

# Look where an earlier run, Homebrew or the official installer would have put node.
ps_find_node() {
  # shellcheck disable=SC2086 # the directory list is deliberately split on spaces
  for ps_dir in "$HOME/.local/bin" $PS_SYSTEM_DIRS; do
    if [ -x "$ps_dir/node" ] && ps_node_ok "$ps_dir/node"; then
      PI_SETUP_USER_PATH="$PATH"; export PI_SETUP_USER_PATH
      PATH="$ps_dir:$PATH"; export PATH
      return 0
    fi
  done
  return 1
}

ps_find_brew() {
  # shellcheck disable=SC2086 # the directory list is deliberately split on spaces
  for ps_b in $PS_SYSTEM_DIRS; do
    if [ -x "$ps_b/brew" ]; then PS_BREW="$ps_b/brew"; return 0; fi
  done
  return 1
}

# sudo prefix: none as root, sudo when a person can type a password, sudo -n otherwise.
ps_priv_text() {
  if [ "$PS_OS" != Linux ] || [ "$(id -u)" = 0 ]; then PS_PRIV=""
  elif [ "$PS_INTERACTIVE" = 1 ] || [ "$PS_DRY" = 1 ]; then PS_PRIV="sudo "
  else PS_PRIV="sudo -n "
  fi
}

ps_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "" ;;
  esac
}

# The plan, one command per line, exactly as it will run (versions in <...> are resolved at run time).
ps_plan_lines() {
  case "$PS_OS" in
    Darwin)
      if [ -n "${PS_BREW:-}" ]; then echo "brew install node"
      else
        echo "NONINTERACTIVE=1 /bin/bash -c \"\$(curl -fsSL $PS_BREW_INSTALLER)\""
        echo "brew install node"
      fi ;;
    Linux)
      if ! command -v curl >/dev/null 2>&1; then
        if [ "$PS_PM" = apt ]; then echo "${PS_PRIV}apt-get install -y curl ca-certificates"
        else echo "${PS_PRIV}dnf install -y curl ca-certificates"; fi
      fi
      echo "curl -fsSL $PS_NODE_MAJOR_URL/SHASUMS256.txt"
      echo "curl -fsSL $PS_NODE_MAJOR_URL/node-v24.<x.y>-linux-$PS_ARCH.tar.gz   (SHA-256 checked)"
      echo "tar -xzf node-v24.<x.y>-linux-$PS_ARCH.tar.gz -C ~/.local/lib/nodejs"
      echo "ln -s ~/.local/lib/nodejs/node-v24.<x.y>-linux-$PS_ARCH/bin/{node,npm,npx} ~/.local/bin/" ;;
  esac
}

ps_run() {
  ps_say "Running: $*"
  "$@" || ps_die "Failed (exit $?): $*
Fix the problem, then re-run ./install.sh: it continues from here."
}

ps_run_priv() {
  ps_say "Running: ${PS_PRIV}$*"
  if [ -n "$PS_PRIV" ]; then
    command -v sudo >/dev/null 2>&1 || ps_die "sudo is not available. Run this as root, then re-run ./install.sh:
  $*"
    if [ "$PS_PRIV" = "sudo -n " ]; then sudo -n "$@"; else sudo "$@"; fi || ps_die "Failed (exit $?): ${PS_PRIV}$*
Fix the problem, then re-run ./install.sh: it continues from here."
  else
    "$@" || ps_die "Failed (exit $?): $*
Fix the problem, then re-run ./install.sh: it continues from here."
  fi
}

ps_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

ps_link() {
  mkdir -p "$HOME/.local/bin"
  for ps_tool in node npm npx; do
    ps_target="$HOME/.local/bin/$ps_tool"
    if [ -e "$ps_target" ] || [ -L "$ps_target" ]; then
      if [ -L "$ps_target" ]; then rm -f "$ps_target"
      else ps_die "$ps_target already exists and is not a link: not overwriting it. Move it away, then re-run ./install.sh."; fi
    fi
    ln -s "$1/bin/$ps_tool" "$ps_target"
  done
}

ps_linux_node() {
  if ! command -v curl >/dev/null 2>&1; then
    if [ "$PS_PM" = apt ]; then ps_run_priv apt-get install -y curl ca-certificates
    else ps_run_priv dnf install -y curl ca-certificates; fi
  fi
  ps_tmp="$(mktemp -d)"
  ps_run curl -fsSL -o "$ps_tmp/SHASUMS256.txt" "$PS_NODE_MAJOR_URL/SHASUMS256.txt"
  ps_file="$(grep " node-v24\.[0-9.]*-linux-$PS_ARCH\.tar\.gz\$" "$ps_tmp/SHASUMS256.txt" | head -n 1 | sed 's/^[0-9a-f]*  *//')"
  [ -n "$ps_file" ] || { rm -rf "$ps_tmp"; ps_die "Could not find a Node 24 build for linux-$PS_ARCH in $PS_NODE_MAJOR_URL/SHASUMS256.txt"; }
  ps_want="$(grep " $ps_file\$" "$ps_tmp/SHASUMS256.txt" | head -n 1 | cut -d' ' -f1)"
  ps_run curl -fsSL -o "$ps_tmp/$ps_file" "$PS_NODE_MAJOR_URL/$ps_file"
  ps_have="$(ps_sha256 "$ps_tmp/$ps_file")"
  [ "$ps_have" = "$ps_want" ] || { rm -rf "$ps_tmp"; ps_die "Node download checksum mismatch for $ps_file (expected $ps_want, got $ps_have). Nothing was installed."; }
  mkdir -p "$HOME/.local/lib/nodejs"
  ps_run tar -xzf "$ps_tmp/$ps_file" -C "$HOME/.local/lib/nodejs"
  rm -rf "$ps_tmp"
  ps_link "$HOME/.local/lib/nodejs/${ps_file%.tar.gz}"
  PI_SETUP_USER_PATH="$PATH"; export PI_SETUP_USER_PATH
  PATH="$HOME/.local/bin:$PATH"; export PATH
}

ps_darwin_node() {
  if [ -z "${PS_BREW:-}" ]; then
    command -v curl >/dev/null 2>&1 || ps_die "curl is needed to install Homebrew. Install Homebrew from https://brew.sh, then re-run ./install.sh."
    ps_say "Running: NONINTERACTIVE=1 /bin/bash -c \"\$(curl -fsSL $PS_BREW_INSTALLER)\""
    ps_script="$(curl -fsSL "$PS_BREW_INSTALLER")" || ps_die "Could not download the Homebrew installer from $PS_BREW_INSTALLER"
    NONINTERACTIVE=1 /bin/bash -c "$ps_script" >&2 || ps_die "The Homebrew installer failed. See https://brew.sh, then re-run ./install.sh."
    ps_find_brew || ps_die "Homebrew was installed but brew was not found in /opt/homebrew/bin or /usr/local/bin."
    PI_SETUP_BREW_SHELLENV="$PS_BREW"; export PI_SETUP_BREW_SHELLENV
    PI_SETUP_USER_PATH="$PATH"; export PI_SETUP_USER_PATH
    PATH="$(dirname "$PS_BREW"):$PATH"; export PATH
  fi
  ps_run "${PS_BREW:-brew}" install node
  PI_SETUP_USER_PATH="${PI_SETUP_USER_PATH:-$PATH}"; export PI_SETUP_USER_PATH
  PATH="$(dirname "${PS_BREW:-brew}"):$PATH"; export PATH
}

ps_preflight() {
  ps_scan "$@"
  if command -v node >/dev/null 2>&1 && ps_node_ok node; then return 0; fi
  if ps_find_node; then return 0; fi
  PS_NEED="pi-setup needs Node.js >= 22.19 (pi needs it too)"
  if command -v node >/dev/null 2>&1; then PS_NEED="$PS_NEED (found $(node -p process.versions.node 2>/dev/null || echo unknown))"; fi

  PS_OS="$(uname -s 2>/dev/null || echo unknown)"
  PS_BREW="" PS_PM="" PS_ARCH=""
  case "$PS_OS" in
    MINGW*|MSYS*|CYGWIN*) ps_die "$PS_NEED. pi-setup does not run in a native Windows shell: use WSL2 (https://learn.microsoft.com/windows/wsl/install), then run ./install.sh there." ;;
    Darwin)
      if ! ps_find_brew && command -v brew >/dev/null 2>&1; then PS_BREW=brew; fi ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then PS_PM=apt
      elif command -v dnf >/dev/null 2>&1; then PS_PM=dnf
      fi
      PS_ARCH="$(ps_arch)"
      [ -n "$PS_PM" ] && [ -n "$PS_ARCH" ] || ps_die "$PS_NEED. Install it from https://nodejs.org, then re-run ./install.sh. (Automatic install needs apt or dnf on x86_64 or arm64.)" ;;
    *) ps_die "$PS_NEED. Install it from https://nodejs.org, then re-run ./install.sh." ;;
  esac
  ps_priv_text

  PS_MANUAL="$PS_NEED: install it from https://nodejs.org, with brew install node, or with nvm."
  if [ "$PS_CMD" = doctor ]; then
    ps_say "$PS_MANUAL"
    ps_say "Fix: $(ps_plan_lines | head -n 1)"
    ps_say "Run ./install.sh to set up the rest."
    exit 2
  fi

  # Consent: explicit flags win; --yes takes the defaults (install on a fresh machine, never with --skip-npm).
  PS_GO="no"
  if [ "$PS_CONSENT" = yes ]; then PS_GO="yes"
  elif [ -z "$PS_CONSENT" ] && [ "$PS_INTERACTIVE" = 1 ]; then PS_GO="ask"
  elif [ -z "$PS_CONSENT" ] && [ "$PS_YES" = 1 ] && [ "$PS_SKIP_NPM" = 0 ] && ps_fresh; then PS_GO="yes"
  fi

  ps_say "$PS_NEED."
  ps_say "Found: $PS_OS${PS_PM:+ with $PS_PM}${PS_BREW:+ with Homebrew}, Node.js not usable"
  ps_say "Commands I will run:"
  ps_plan_lines | while IFS= read -r ps_line; do ps_say "  $ps_line"; done
  if [ "$PS_DRY" = 1 ]; then
    ps_plan_lines | while IFS= read -r ps_line; do ps_say "Would run: $ps_line"; done
    exit 0
  fi
  if [ -n "$PS_PRIV" ]; then ps_say "Some of these run with sudo; you may be asked for your password."; fi
  ps_say "This takes about 2-5 minutes."
  if [ "$PS_GO" = ask ]; then
    printf 'Continue? [y/N] ' >&2
    ps_answer=""
    read -r ps_answer </dev/tty || ps_answer=""
    case "$ps_answer" in y|Y|yes|YES) PS_GO="yes" ;; *) PS_GO="no" ;; esac
  fi
  if [ "$PS_GO" != yes ]; then
    ps_die "$PS_NEED. Nothing was installed. To let the installer do it: ./install.sh --install-prereqs
Or by hand: install it from https://nodejs.org, with brew install node, or with nvm."
  fi

  case "$PS_OS" in
    Darwin) ps_darwin_node ;;
    Linux) ps_linux_node ;;
  esac
  ps_node_ok node || ps_die "Node.js was installed but is still not usable on PATH. Open a new terminal and re-run ./install.sh."
  ps_say "✓ Node.js ready: $(node -p process.versions.node)"
}
