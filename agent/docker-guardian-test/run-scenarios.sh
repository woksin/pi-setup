#!/bin/bash
# Dry run of docker-guardian's load deferral with stubbed docker/sysctl/sleep/osascript/open/pgrep/pkill.
# Never touches the real Docker, the real guardian state or the lane messages.
# Usage: run-scenarios.sh [path-to-guardian]; all Docker and machine commands are fake.
set -u
here=$(cd "$(dirname "$0")" && pwd)
G=${1:-$here/../bin/docker-guardian}
ROOT=${AI_WORK_OUTPUT:-$here/../../.ai-work/guardian-scenarios}
mkdir -p "$ROOT"
fail=0

mkstubs(){ # $1 = scenario dir
  local T=$1 B=$1/bin; mkdir -p "$B"
  # scenario file lines: "<step> <info ok|fail> <ps ok|fail> <load>"; step 0 = before the deferral
  cat > "$B/docker" <<EOF
#!/bin/bash
T=$T; read -r info ps load < "\$T/now"
case "\$1" in
  info) [ "\$info" = ok ] && echo 29.0.0 || exit 1 ;;
  ps)   [ "\$ps" = ok ] || exit 1 ;;
  *)    exit 0 ;;
esac
EOF
  cat > "$B/sysctl" <<EOF
#!/bin/bash
read -r info ps load < "$T/now"; echo "{ \$load.00 \$load.00 \$load.00 }"
EOF
  cat > "$B/sleep" <<EOF
#!/bin/bash
# only the 60 s deferral step advances the scenario; other sleeps are no-ops
if [ "\$1" = 60 ]; then n=\$(( \$(cat "$T/step") + 1 )); echo \$n > "$T/step"
  line=\$(awk -v s=\$n '\$1==s{print \$2, \$3, \$4}' "$T/scenario"); [ -n "\$line" ] && echo "\$line" > "$T/now"; fi
exit 0
EOF
  cat > "$B/open" <<EOF
#!/bin/bash
echo restarted >> "$T/actions"; echo "ok ok 30" > "$T/now"
EOF
  for c in osascript pkill; do printf '#!/bin/bash\nexit 0\n' > "$B/$c"; done
  printf '#!/bin/bash\nexit 0\n' > "$B/pgrep"   # Docker always "running"
  chmod +x "$B"/*
}

# run <name> <expect: restart|norestart> <initial fails> <extra-setup-cmd> ; scenario lines on stdin
run(){
  local name=$1 expect=$2 fails0=$3 setup=$4 T; T=$(mktemp -d "$ROOT/scenario.XXXXXX")
  cat > "$T/scenario"; mkstubs "$T"; mkdir -p "$T/state"
  echo 0 > "$T/step"; awk '$1==0{print $2, $3, $4}' "$T/scenario" > "$T/now"
  echo "$fails0" > "$T/state/fails"; date +%s > "$T/state/last-gc"; date +%s > "$T/state/last-doctor"; : > "$T/actions"
  [ -n "$setup" ] && (cd "$T/state" && eval "$setup")
  env -u DOCKER_GUARDIAN_MESSAGES HOME="$T/home" DOCKER_GUARDIAN_TEST_PATH="$T/bin" DOCKER_GUARDIAN_STATE="$T/state" DOCKER_GUARDIAN_LOG="$T/log" bash "$G" 2>"$T/stderr"
  local got=norestart; grep -q restarted "$T/actions" && got=restart
  local res=PASS; [ "$got" = "$expect" ] || { res=FAIL; fail=1; }
  echo "== $res $name (expected $expect, got $got, steps $(cat "$T/step"))"; [ ! -f "$T/log" ] || sed 's/^[0-9-]* [0-9:]* /   /' "$T/log"
  [ -s "$T/stderr" ] && { echo "   stderr:"; sed 's/^/   /' "$T/stderr"; }
  rm -rf "$T"
}

# Replay of 2026-10-20 21:40-21:58: info answers, ps times out, load ~90 (21:55 x2 -> 21:58 x3).
run "21:55 x2 -> x3 under load 90: first miss count only" norestart 0 "" <<'S'
0 ok fail 90
S
run "21:58 x3, load stays 90 for 10 min: defer 10 steps then restart" restart 2 "" <<'S'
0 ok fail 90
S
run "x3 under load 90, ps answers after 3 min: no restart" norestart 2 "" <<'S'
0 ok fail 90
3 ok ok 85
S
run "x3 under load 90, load drops to 30 at 4 min, ps still fails: restart" restart 2 "" <<'S'
0 ok fail 90
4 ok fail 30
S
run "x3 under load 90, docker info stops answering at 2 min: restart" restart 2 "" <<'S'
0 ok fail 90
2 fail fail 90
S
run "x3 with info failing (real wedge) under load 90: no deferral, restart" restart 2 "" <<'S'
0 fail fail 90
S
run "x3 at load 20 (17:30-type wedge, ps hung): no deferral, restart" restart 2 "" <<'S'
0 ok fail 20
S
run "x3 under load 90 with load-defer-off: old behaviour, restart at once" restart 2 "touch load-defer-off" <<'S'
0 ok fail 90
S
run "healthy at load 90: nothing happens" norestart 0 "" <<'S'
0 ok ok 90
S

# Image hygiene fixtures: only fake docker/phase executables run, never the engine.
run_images(){
  local name=$1 expect=$2 T
  T=$(mktemp -d "$ROOT/images.XXXXXX")
  mkstubs "$T"; mkdir -p "$T/state" "$T/home/.pi/agent/bin"
  echo 'ok ok 20' > "$T/now"
  date +%s > "$T/state/last-doctor"
  echo 0 > "$T/state/last-gc"
  : > "$T/actions"
  cp "$here/../docker-guardian/pinned.example.txt" "$T/state/pinned.txt"
  python3 - "$T" "$name" <<'PY'
import datetime as dt
import json
from pathlib import Path
import sys
root, name = Path(sys.argv[1]), sys.argv[2]
now = dt.datetime.now(dt.timezone.utc)
def image(letter, tags, hours=48):
    return dict(Id='sha256:' + letter * 64, RepoTags=tags,
                Created=(now - dt.timedelta(hours=hours)).isoformat())
images = [image('a', ['example:1.0.0']), image('b', ['example:1.1.0']), image('c', ['example:1.2.0'])]
if name == 'only-two-tags':
    images = images[:2]
if name == 'pinned':
    (root / 'state/pinned.txt').write_text('example:1.*\n')
if name.startswith('dangling'):
    images = [image('a', None, 48 if name == 'dangling-old' else 12)]
if name == 'recent':
    images[0] = image('a', ['example:1.0.0'], 1)
if name == 'floating':
    images[0]['RepoTags'].append('example:latest')
(root / 'fixture.json').write_text(json.dumps(dict(name=name, images=images)))
PY
  cat > "$T/bin/docker" <<'PY'
#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
root = Path(os.environ['IMAGE_TEST_ROOT'])
data = json.loads((root / 'fixture.json').read_text())
a = sys.argv[1:]
images = data['images']
if a[0] == 'info':
    print('29.0.0')
elif a[0] == 'context':
    if a[1] == 'show':
        print('remote' if data['name'] == 'remote' else 'desktop-linux')
    else:
        print('"unix:///tmp/fake.sock"')
elif a[0] == 'ps':
    if '-aq' in a and '--filter' not in a and data['name'] == 'in-use':
        print('d' * 64)
elif a[:2] == ['image', 'ls']:
    print('\n'.join(i['Id'] for i in images))
elif a[:2] == ['image', 'inspect']:
    refs = a[2:]
    print(json.dumps([i for i in images if i['Id'] in refs or any(t in refs for t in (i['RepoTags'] or []))]))
elif a[0] == 'inspect':
    print('sha256:' + 'a' * 64)
elif a[0] == 'rmi':
    if len(a) != 2 or a[1].startswith('-'):
        raise SystemExit('unsafe rmi')
    with (root / 'actions').open('a') as stream:
        stream.write(a[1] + '\n')
    print(a[1])
PY
  cat > "$T/home/.pi/agent/bin/pi-phase" <<'SH_PHASE'
#!/bin/sh
case "$IMAGE_TEST_NAME" in
  integration) echo 'pi-phase: integration specs pid=1 cwd=/tmp elapsed=1s running' ;;
  unknown-phase) exit 1 ;;
  *) echo 'pi-phase: no active phases' ;;
esac
SH_PHASE
  chmod +x "$T/bin/docker" "$T/home/.pi/agent/bin/pi-phase"
  env -u DOCKER_GUARDIAN_MESSAGES DOCKER_HOST= HOME="$T/home" IMAGE_TEST_ROOT="$T" IMAGE_TEST_NAME="$name" DOCKER_GUARDIAN_TEST_PATH="$T/bin" DOCKER_GUARDIAN_STATE="$T/state" DOCKER_GUARDIAN_LOG="$T/log" bash "$G" 2>"$T/stderr"
  local code=$? got
  got=$(cat "$T/actions")
  if [ "$code" -eq 0 ] && [ "$got" = "$expect" ]; then
    echo "== PASS image $name"
  else
    echo "== FAIL image $name (exit=$code expected='$expect' got='$got')"; fail=1
    cat "$T/log" "$T/stderr"
  fi
  rm -rf "$T"
}
run_images superseded 'example:1.0.0'
run_images in-use ''
run_images pinned ''
run_images only-two-tags ''
run_images dangling-old "sha256:$(printf '%64s' '' | tr ' ' a)"
run_images dangling-young ''
run_images recent ''
run_images floating ''
run_images integration ''
run_images unknown-phase ''
run_images remote ''
exit $fail
