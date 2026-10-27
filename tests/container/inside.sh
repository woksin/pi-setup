#!/bin/sh
# Runs inside the clean Ubuntu container: machine setup as root (not part of the product), then the install scenarios as a normal user.
set -eu

if [ "$(id -u)" = 0 ]; then
  # Machine setup: a normal user with passwordless sudo, as on a fresh developer machine. The installer must find its own way from here.
  apt-get update >/dev/null
  apt-get install -y sudo >/dev/null
  useradd -m -s /bin/bash dev
  echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
  mkdir -p /home/dev/pi-setup
  tar -xzf /in/src.tgz -C /home/dev/pi-setup
  cp /in/assert-doctor.py /home/dev/assert-doctor.py
  chown -R dev:dev /home/dev
  exec su dev -c 'sh /in/inside.sh'
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }
cd "$HOME/pi-setup"

step "S0 --help without Node shows help, not the install plan"
help="$(./install.sh --help 2>&1)" || fail "S0: --help exited non-zero"
echo "$help" | head -n 3
echo "$help" | grep -q "^Usage: ./install.sh" || fail "S0: no usage text"
echo "$help" | grep -q -- "--install-prereqs" || fail "S0: usage does not list --install-prereqs"
if echo "$help" | grep -qi "Step 1 of 2\|Would run"; then fail "S0: help showed the install plan"; fi
if command -v node >/dev/null 2>&1; then fail "S0: node exists after --help"; fi

step "S1 dry-run: plans, installs nothing"
touch "$HOME/.marker"; sleep 1
out="$(./install.sh --dry-run 2>&1)" || fail "S1: dry-run exited non-zero"
echo "$out"
echo "$out" | grep -q "apt-get" || fail "S1: plan does not name apt-get"
echo "$out" | grep -q "nodejs.org" || fail "S1: plan does not name nodejs.org"
echo "$out" | grep -q "Dry run: nothing changed. Next: ./install.sh" || fail "S1: no dry-run closing line"
if command -v node >/dev/null 2>&1; then fail "S1: node exists after a dry-run"; fi
changed="$(find "$HOME" -newer "$HOME/.marker" -not -path "$HOME/pi-setup/*" -not -name .marker 2>/dev/null | head -n 5)"
[ -z "$changed" ] || fail "S1: dry-run changed files: $changed"

step "S2 no consent: --no-install-prereqs stops with the way on"
if out="$(./install.sh --yes --no-install-prereqs --user ci-bot --repos-root "$HOME/repos" 2>&1)"; then fail "S2: expected a non-zero exit"; fi
echo "$out"
echo "$out" | grep -q -- "--install-prereqs" || fail "S2: message does not name --install-prereqs"
if command -v node >/dev/null 2>&1; then fail "S2: node was installed without consent"; fi

step "S3 first-time install: one command"
./install.sh --yes --install-prereqs --user ci-bot --repos-root "$HOME/repos" 2>&1 | tee "$HOME/s3.log"
grep -q "gh auth login" "$HOME/s3.log" || fail "S3: no gh auth login in the next steps"
grep -q "/login" "$HOME/s3.log" || fail "S3: no /login in the next steps"
grep -q "Setup finished. Next: follow steps" "$HOME/s3.log" || fail "S3: no closing line"
grep -q "Health check: ok" "$HOME/s3.log" || fail "S3: no one-line health check"
grep -q "Full log: ~/.local/state/pi-setup/install.log" "$HOME/s3.log" || fail "S3: no log path"
grep -q "Undo any time: ./install.sh uninstall" "$HOME/s3.log" || fail "S3: no undo line"
if grep -q "✖" "$HOME/s3.log"; then fail "S3: a red ✖ line on a successful install"; fi
if grep -qE "^(install |register )|EBADENGINE|npm warn|npm notice|\._" "$HOME/s3.log"; then fail "S3: per-file or npm noise on screen"; fi
if grep -q 'pi-setup/install\.sh' "$HOME/s3.log"; then fail "S3: hint uses a hard-coded repo path"; fi
[ -z "$(find "$HOME/.pi" -name '._*' 2>/dev/null)" ] || fail "S3: AppleDouble files were installed"

step "S3b fresh-HOME PATH: pi resolves in a new login shell"
bash -lic 'pi --version' 2>&1 | tee "$HOME/pi-version.log"
grep -qE "[0-9]+\.[0-9]+\.[0-9]+" "$HOME/pi-version.log" || fail "S3b: pi --version did not resolve in a new login shell"
ls "$HOME"/.bashrc.pi-setup-bak-* >/dev/null 2>&1 || ls "$HOME"/.bashrc >/dev/null 2>&1 || fail "S3b: no shell profile"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 26 ] || fail "S3b: Node $node_major does not satisfy @woksin/pi-orch (needs >=26)"

step "S4 re-run: safe, fast, quiet"
PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH" ./install.sh --yes --user ci-bot --repos-root "$HOME/repos" 2>&1 | tee "$HOME/s4.log"
grep -q "Everything up to date" "$HOME/s4.log" || fail "S4: re-run did not say Everything up to date"
if grep -qE "^(→|Running:)" "$HOME/s4.log"; then fail "S4: re-run ran installers again"; fi

step "S5 doctor"
set +e
PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH" ./install.sh doctor --json > "$HOME/d.json"
code=$?
set -e
[ "$code" -le 2 ] || fail "S5: doctor exit $code"
PATH="$HOME/.local/bin:$PATH" python3 "$HOME/assert-doctor.py" "$HOME/d.json" || fail "S5: doctor checks"

echo; echo "ALL SCENARIOS PASSED"
