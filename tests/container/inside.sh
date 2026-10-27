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

step "S1 dry-run: plans, installs nothing"
touch "$HOME/.marker"; sleep 1
out="$(./install.sh --dry-run 2>&1)" || fail "S1: dry-run exited non-zero"
echo "$out"
echo "$out" | grep -q "apt-get" || fail "S1: plan does not name apt-get"
echo "$out" | grep -q "nodejs.org" || fail "S1: plan does not name nodejs.org"
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

step "S4 re-run: safe, fast, quiet"
PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH" ./install.sh --yes --user ci-bot --repos-root "$HOME/repos" 2>&1 | tee "$HOME/s4.log"
grep -q "Everything up to date" "$HOME/s4.log" || fail "S4: re-run did not say Everything up to date"
if grep -q "^Running:" "$HOME/s4.log"; then fail "S4: re-run ran installers again"; fi

step "S5 doctor"
set +e
PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH" ./install.sh doctor --json > "$HOME/d.json"
code=$?
set -e
[ "$code" -le 2 ] || fail "S5: doctor exit $code"
PATH="$HOME/.local/bin:$PATH" python3 "$HOME/assert-doctor.py" "$HOME/d.json" || fail "S5: doctor checks"

echo; echo "ALL SCENARIOS PASSED"
