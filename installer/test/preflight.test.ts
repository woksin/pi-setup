import { strict as assert } from "node:assert";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { after, test } from "node:test";
import { REPO, sandbox, snapshot } from "./helpers/home.ts";
import type { Sandbox } from "./helpers/home.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => rmSync(b.root, { recursive: true, force: true })));

// Real utilities the preflight declares; nothing else (no host node, brew, curl, apt-get) can leak in.
const UTILITIES = ["cat", "mkdir", "ln", "rm", "sed", "grep", "tr", "head", "cut", "dirname", "basename", "tar", "gzip", "mktemp", "chmod", "readlink", "sha256sum", "shasum", "perl", "sleep", "cp"];

const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); chmodSync(path, 0o755); };
const which = (name: string): string | undefined => { const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : undefined; };

interface Env { b: Sandbox; stubs: string; sysbin: string; systemDirs: string; calls: () => string[] }

const NODE_STUB = `#!/bin/sh
if [ "$1" = "-e" ]; then exec "$REAL_NODE" -e 'Object.defineProperty(process.versions,"node",{value:process.env.TEST_NODE_VERSION});eval(process.argv[1])' "$2"; fi
if [ "$1" = "-p" ]; then echo "$TEST_NODE_VERSION"; fi
exit 0
`;

function setup(commands: string[], opts: { os?: string; arch?: string; uid?: string; node?: boolean } = {}): Env {
  const b = sandbox(); boxes.push(b);
  const stubs = join(b.root, "pstubs"), sysbin = join(b.root, "sysbin"), systemDirs = join(b.root, "systemdirs");
  for (const d of [stubs, sysbin, systemDirs]) mkdirSync(d, { recursive: true });
  for (const u of UTILITIES) { const p = which(u); if (p) try { execFileSync("ln", ["-s", p, join(sysbin, u)]); } catch { /* optional utility */ } }
  const log = join(b.root, "ps.log");
  const logging = (name: string) => `echo "${name} $*" >> "${log}"\n`;
  put(join(stubs, "uname"), `#!/bin/sh\ncase "$1" in -s) echo "${opts.os ?? "Linux"}" ;; -m) echo "${opts.arch ?? "x86_64"}" ;; esac\n`);
  put(join(stubs, "id"), `#!/bin/sh\necho "${opts.uid ?? "1000"}"\n`);
  if (opts.node) put(join(stubs, "node"), NODE_STUB);
  for (const c of commands) put(join(stubs, c), `#!/bin/sh\n${logging(c)}exit 0\n`);
  return { b, stubs, sysbin, systemDirs, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

function runInstall(e: Env, args: string[], extra: Record<string, string> = {}) {
  return spawnSync("/bin/sh", [join(REPO, "install.sh"), ...args], {
    encoding: "utf8", input: "",
    env: { HOME: e.b.home, PATH: `${e.stubs}:${e.sysbin}`, PI_SETUP_SYSTEM_BIN_DIRS: e.systemDirs, REAL_NODE: process.execPath, TEST_NODE_VERSION: "24.0.0", ...extra },
  });
}

test("Node >= 22.19 present: no preflight output, node gets the original arguments", () => {
  const e = setup([], { node: true, os: "Darwin" });
  put(join(e.stubs, "node"), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "$REAL_NODE" -e 'Object.defineProperty(process.versions,"node",{value:"22.19.0"});eval(process.argv[1])' "$2"; fi\necho "ran $*" >&2\n`);
  const r = runInstall(e, ["--yes", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^ran .*pi-setup\.mjs install --yes --help\n$/);
});

test("macOS, brew present, node missing: --dry-run plans and touches nothing", () => {
  const e = setup(["brew"], { os: "Darwin" });
  const before = snapshot(e.b.home);
  const r = runInstall(e, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, / {2}brew install node/);
  assert.deepEqual(e.calls(), []);
  assert.deepEqual(snapshot(e.b.home), before);
  assert.equal(r.stdout, "");
});

test("macOS: flags decide; --yes on a fresh HOME installs, --yes --skip-npm and an existing install do not", () => {
  const withBrew = () => { const e = setup(["brew"], { os: "Darwin" }); put(join(e.stubs, "brew"), `#!/bin/sh\necho "brew $*" >> "${e.b.root}/ps.log"\ncp "${e.stubs}/node-real" "${e.stubs}/node"\n`); put(join(e.stubs, "node-real"), NODE_STUB); return e; };
  const none = withBrew();
  const refused = runInstall(none, ["--no-install-prereqs", "--yes"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /needs Node\.js >= 22\.19/);
  assert.match(refused.stderr, /--install-prereqs/);
  assert.deepEqual(none.calls(), []);

  const held = withBrew();
  assert.equal(runInstall(held, ["--yes", "--skip-npm"]).status, 1);
  assert.deepEqual(held.calls(), []);

  const update = withBrew();
  mkdirSync(join(update.b.home, ".pi/agent"), { recursive: true });
  assert.equal(runInstall(update, ["--yes"]).status, 1);
  assert.deepEqual(update.calls(), []);

  const fresh = withBrew();
  const r = runInstall(fresh, ["--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fresh.calls(), ["brew install node"]);
  assert.match(r.stderr, /Step 1 of 2: install Node\.js with Homebrew/);

  const flagged = withBrew();
  mkdirSync(join(flagged.b.home, ".pi/agent"), { recursive: true });
  assert.equal(runInstall(flagged, ["--yes", "--install-prereqs"]).status, 0);
  assert.deepEqual(flagged.calls(), ["brew install node"]);
});

test("macOS, no brew: the plan shows the official Homebrew installer, then brew install node", () => {
  const e = setup([], { os: "Darwin" });
  const r = runInstall(e, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, / {2}NONINTERACTIVE=1 \/bin\/bash -c .*raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh/);
  assert.match(r.stderr, / {2}brew install node/);
});

test("Linux, node missing, non-root, curl missing: the plan names sudo apt-get, the download, checksum, extraction and links", () => {
  const e = setup(["apt-get", "sudo"]);
  const r = runInstall(e, ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  for (const re of [/ {2}sudo apt-get install -y curl ca-certificates/, /nodejs\.org\/dist\/latest-v26\.x\/SHASUMS256\.txt/, /node-v26\.<x\.y>-linux-x64\.tar\.gz {3}\(SHA-256 checked\)/, /tar -xzf/, /~\/\.local\/bin\//]) assert.match(r.stderr, re);
  assert.deepEqual(e.calls(), []);
  assert.match(runInstall(setup(["apt-get", "sudo"], { uid: "0" }), ["--dry-run"]).stderr, / {2}apt-get install -y curl/);
  assert.match(runInstall(setup(["apt-get", "sudo"]), ["--yes", "--no-install-prereqs", "--dry-run"]).stderr, / {2}sudo apt-get/);
});

/** A fake node tarball and a curl stub that serves it; `sum` can be wrong on purpose. */
function linuxFixture(e: Env, sum?: string) {
  const name = "node-v26.0.0-linux-x64";
  const dir = join(e.b.root, "fx", name);
  put(join(dir, "bin/node"), NODE_STUB);
  put(join(dir, "bin/npm"), "#!/bin/sh\nexit 0\n");
  put(join(dir, "bin/npx"), "#!/bin/sh\nexit 0\n");
  const tgz = join(e.b.root, "fx", `${name}.tar.gz`);
  execFileSync("tar", ["-czf", tgz, "-C", join(e.b.root, "fx"), name]);
  const real = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  writeFileSync(join(e.b.root, "fx", "SHASUMS256.txt"), `${"0".repeat(64)}  node-v26.0.0-linux-arm64.tar.gz\n${sum ?? real}  ${name}.tar.gz\n`);
  put(join(e.stubs, "curl"), `#!/bin/sh
echo "curl $*" >> "${e.b.root}/ps.log"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done
src="${e.b.root}/fx/$(basename "$url")"
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
`);
  return name;
}

test("Linux: executes the download, verifies the checksum, extracts and links node, then execs the installer", () => {
  const e = setup(["sudo", "apt-get"], { uid: "0" });
  const name = linuxFixture(e);
  const r = runInstall(e, ["--yes", "--install-prereqs", "--json"], { PATH: `${e.stubs}:${e.sysbin}` });
  assert.equal(r.status, 0, r.stderr);
  for (const tool of ["node", "npm", "npx"]) assert.equal(readlinkSync(join(e.b.home, ".local/bin", tool)), join(e.b.home, ".local/lib/nodejs", name, "bin", tool));
  assert.match(r.stderr, /✓ Node\.js 24\.0\.0 ready/);
  assert.ok(e.calls().some((c) => c.includes("SHASUMS256.txt")));
});

test("Linux: a checksum mismatch stops with nothing linked", () => {
  const e = setup(["sudo", "apt-get"], { uid: "0" });
  linuxFixture(e, "f".repeat(64));
  const r = runInstall(e, ["--yes", "--install-prereqs"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /checksum mismatch/);
  assert.ok(!existsSync(join(e.b.home, ".local/bin/node")));
});

test("Linux: an existing non-link ~/.local/bin/node is refused, never overwritten", () => {
  const e = setup(["sudo", "apt-get"], { uid: "0" });
  linuxFixture(e);
  put(join(e.b.home, ".local/bin/node"), "#!/bin/sh\necho mine\nexit 3\n");
  const r = runInstall(e, ["--yes", "--install-prereqs"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists and is not a link/);
  assert.ok(lstatSync(join(e.b.home, ".local/bin/node")).isFile());
  assert.match(readFileSync(join(e.b.home, ".local/bin/node"), "utf8"), /echo mine/);
});

test("Windows shells and unknown systems stop with a clear message", () => {
  const win = runInstall(setup([], { os: "MINGW64_NT-10.0" }), ["--yes"]);
  assert.equal(win.status, 1);
  assert.match(win.stderr, /WSL2/);
  const other = runInstall(setup([], { os: "FreeBSD" }), ["--yes"]);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /nodejs\.org/);
});

test("doctor with node missing exits 2 with the fix command and the way on", () => {
  const e = setup(["brew"], { os: "Darwin" });
  const r = runInstall(e, ["doctor"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Fix: brew install node/);
  assert.match(r.stderr, /Run \.\/install\.sh to set up the rest/);
  assert.deepEqual(e.calls(), []);
});

test("a node from an earlier run in ~/.local/bin is found without installing", () => {
  const e = setup(["brew"], { os: "Darwin" });
  put(join(e.b.home, ".local/bin/node"), NODE_STUB);
  const r = runInstall(e, ["--yes", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(e.calls(), []);
});

test("output goes to stderr, so --json stdout stays clean", () => {
  const e = setup(["brew"], { os: "Darwin" });
  const r = runInstall(e, ["--json", "--plan"]);
  assert.equal(r.stdout, "");
  assert.notEqual(r.stderr, "");
});

test("--help with no Node prints the help, not the install plan; it lists every flag of the real help", () => {
  const e = setup(["brew"], { os: "Darwin" });
  for (const flag of ["--help", "-h"]) {
    const r = runInstall(e, [flag]);
    assert.equal(r.status, 0);
    assert.match(r.stderr + r.stdout, /^Usage: \.\/install\.sh/m);
    assert.doesNotMatch(r.stderr + r.stdout, /Step 1 of 2|would run/i);
  }
  assert.deepEqual(e.calls(), []);
  const real = readFileSync(join(REPO, "installer/src/args.ts"), "utf8");
  const flags = [...real.matchAll(/^\s{2}(--[a-z-]+)/gm)].map((m) => m[1]);
  assert.ok(flags.length > 15);
  const shell = runInstall(e, ["--help"]);
  for (const flag of flags) assert.ok((shell.stderr + shell.stdout).includes(flag), `${flag} missing from the shell help`);
});

test("--dry-run with no Node: the command list once, the closing line, and the note about the rest", () => {
  const r = runInstall(setup(["apt-get", "sudo"]), ["--dry-run"]);
  assert.equal(r.status, 0);
  assert.equal((r.stderr.match(/apt-get install -y curl/g) ?? []).length, 1);
  assert.match(r.stderr, /\(the rest of the plan is shown once Node\.js is installed\)\nDry run: nothing changed\. Next: \.\/install\.sh\n$/);
});

test("--skip-npm is a veto: no install with --install-prereqs, on macOS or Linux", () => {
  const mac = setup(["brew"], { os: "Darwin" });
  const r = runInstall(mac, ["--skip-npm", "--install-prereqs"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--skip-npm means nothing is installed/);
  assert.deepEqual(mac.calls(), []);
  const linux = setup(["sudo", "apt-get"], { uid: "0" });
  linuxFixture(linux);
  const l = runInstall(linux, ["--yes", "--install-prereqs", "--skip-npm"]);
  assert.equal(l.status, 1);
  assert.deepEqual(linux.calls(), []);
  assert.ok(!existsSync(join(linux.b.home, ".local/bin/node")));
  assert.match(runInstall(setup(["apt-get", "sudo"]), ["--skip-npm", "--install-prereqs", "--dry-run"]).stderr, /Dry run: nothing changed/);
});

test("the command word is found after flag values: --user doctor is not the doctor command", () => {
  const e = setup(["brew"], { os: "Darwin" });
  const r = runInstall(e, ["--user", "doctor", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Fix: brew install node/);
  assert.equal(runInstall(e, ["doctor"]).status, 2);
});

test("Linux: apt-get update runs before the prerequisites install, and is in the plan", () => {
  const e = setup(["sudo", "apt-get"], { uid: "0" });
  linuxFixture(e);
  const r = runInstall(e, ["--yes", "--install-prereqs", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const calls = e.calls();
  assert.ok(calls.indexOf("apt-get update") >= 0 && calls.indexOf("apt-get update") < calls.findIndex((c) => c.startsWith("apt-get install")), calls.join("|"));
  assert.match(runInstall(setup(["apt-get", "sudo"]), ["--dry-run"]).stderr, / {2}sudo apt-get update\n {2}sudo apt-get install -y curl/);
});

test("Linux: an existing link in ~/.local/bin is replaced and the log says where it pointed", () => {
  const e = setup(["sudo", "apt-get"], { uid: "0" });
  linuxFixture(e);
  mkdirSync(join(e.b.home, ".local/bin"), { recursive: true });
  execFileSync("ln", ["-s", "/old/place/node", join(e.b.home, ".local/bin/node")]);
  const r = runInstall(e, ["--yes", "--install-prereqs", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(e.b.home, ".local/state/pi-setup/install.log"), "utf8"), /replacing link .*\.local\/bin\/node \(pointed to \/old\/place\/node\)/);
});

test("macOS: a brew found by a relative PATH entry never puts that directory on PATH twice", () => {
  const e = setup([], { os: "Darwin" });
  const rel = join(e.b.root, "rel");
  put(join(rel, "brew"), `#!/bin/sh\necho "brew $*" >> "${e.b.root}/ps.log"\ncp "${e.stubs}/node-real" "${e.stubs}/node"\n`);
  put(join(e.stubs, "node-real"), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "$REAL_NODE" -e 'Object.defineProperty(process.versions,"node",{value:process.env.TEST_NODE_VERSION});eval(process.argv[1])' "$2"; fi\nif [ "$1" = "-p" ]; then echo "$TEST_NODE_VERSION"; exit 0; fi\necho "$PATH" > "${e.b.root}/final-path"\n`);
  const r = spawnSync("/bin/sh", [join(REPO, "install.sh"), "--yes", "--install-prereqs"], {
    encoding: "utf8", input: "", cwd: e.b.root,
    env: { HOME: e.b.home, PATH: `rel:${e.stubs}:${e.sysbin}`, PI_SETUP_SYSTEM_BIN_DIRS: e.systemDirs, REAL_NODE: process.execPath, TEST_NODE_VERSION: "24.0.0" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(readFileSync(join(e.b.root, "final-path"), "utf8"), /^rel:rel:/);
});
