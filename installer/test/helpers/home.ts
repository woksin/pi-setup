import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../../src/types.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Refuse to hand any process a HOME outside the OS temp directory. */
export function assertTempHome(home: string): string {
  const real = realpathSync(home);
  const base = realpathSync(tmpdir());
  if (!real.startsWith(`${base}/`)) throw new Error(`refusing to use ${home} as HOME: not under ${base}`);
  return home;
}

export interface Sandbox {
  root: string;
  home: string;
  stubs: string;
  log: string;
}

export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pisetup-test."));
  const home = join(root, "home");
  const stubs = join(root, "stubs");
  mkdirSync(home);
  mkdirSync(stubs);
  const box = { root, home: assertTempHome(home), stubs, log: join(root, "stub.log") };
  writeStubs(box);
  return box;
}

function script(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function realPython(): string {
  const found = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
  if (!found) throw new Error("python3 is required for these tests");
  return found;
}

function writeStubs(box: Sandbox): void {
  for (const name of ["jq", "rg", "fd", "gitleaks", "rtk", "docker", "tmux"]) script(box.stubs, name, "exit 0");
  script(box.stubs, "pi", `echo "pi $*" >> "$STUB_LOG"
case "$1" in
  --version) echo 1.4.0; exit 0 ;;
  auth)
    case ",$STUB_READY," in
      *",$4,"*) echo "{\\"status\\":\\"ready\\",\\"provider\\":\\"$4\\",\\"authType\\":\\"oauth\\"}"; exit 0 ;;
      *) echo "{\\"status\\":\\"not_ready\\",\\"provider\\":\\"$4\\",\\"reason\\":\\"credentials_not_configured\\"}"; exit 1 ;;
    esac ;;
  --offline) if [ -n "$STUB_MODELS" ]; then printf 'provider  model\\n%s\\n' "$STUB_MODELS"; else echo "No models available. Use /login to log into a provider."; fi; exit 0 ;;
esac
exit 0`);
  script(box.stubs, "gh", `echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "auth status") printf 'github.com\\n  ✓ Logged in to github.com account einari (keyring)\\n  - Active account: true\\n' ;;
  "api user") echo einari ;;
  "api user/orgs") echo Cratis ;;
  *) [ "$1" = "--version" ] && echo "gh version 2.71.0" ;;
esac
exit 0`);
  script(box.stubs, "npm", `case "$1" in --version) echo 10.0.0; exit 0 ;; esac
echo "npm $* cwd=$PWD" >> "$STUB_LOG"
mkdir -p node_modules
for spec in "$@"; do
  case "$spec" in
    @woksin/*@*) name="\${spec%@*}"; version="\${spec##*@}"
      mkdir -p "node_modules/$name"
      printf '{"version":"%s"}\\n' "$version" > "node_modules/$name/package.json" ;;
  esac
done
# Like a real npm: every dependency in package.json ends up in node_modules.
for name in $(grep -o '"[@a-z][^"]*": *"[^"]*"' package.json 2>/dev/null | sed 's/": *".*//; s/^"//' | grep -v '^name$' | grep -v '^version$' | grep -v '^private$'); do
  [ -f "node_modules/$name/package.json" ] || { mkdir -p "node_modules/$name"; printf '{"version":"1.0.0"}\\n' > "node_modules/$name/package.json"; }
done
: > node_modules/.package-lock.json`);
  // Package managers and downloaders are stubs too: a test must never reach the host's brew, apt, dnf, sudo or network.
  // An install "succeeds" by writing a stub of each requested tool next to the stub itself.
  const installs = `dir="$(dirname "$0")"
case "$1" in install) shift ;; *) exit 0 ;; esac
for pkg in "$@"; do
  case "$pkg" in -*) continue ;; ripgrep) tool=rg ;; python) tool=python3 ;; fd-find) tool=fdfind ;; node) tool=node ;; *) tool="$pkg" ;; esac
  printf '#!/bin/sh\\nexit 0\\n' > "$dir/$tool"; chmod +x "$dir/$tool"
done`;
  script(box.stubs, "brew", `echo "brew $*" >> "$STUB_LOG"\n${installs}\nexit 0`);
  script(box.stubs, "apt-get", `echo "apt-get $*" >> "$STUB_LOG"\n${installs}\nexit 0`);
  script(box.stubs, "dnf", `echo "dnf $*" >> "$STUB_LOG"\n${installs}\nexit 0`);
  script(box.stubs, "sudo", `echo "sudo $*" >> "$STUB_LOG"\nif [ "$1" = "-n" ]; then shift; fi\nexec "$@"`);
  script(box.stubs, "curl", `echo "curl $*" >> "$STUB_LOG"\nexit 22`);
  // Never the real service managers: record the call and report "not loaded".
  for (const name of ["launchctl", "systemctl"]) script(box.stubs, name, `echo "${name} $*" >> "$STUB_LOG"\nexit 0`);
  script(box.stubs, "python3", `echo "python3 $*" >> "$STUB_LOG"\nexec "${realPython()}" "$@"`);
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  ready?: string;
  entry?: "shim" | "node";
  path?: string;
  env?: Record<string, string>;
  extraPath?: boolean;
  /** Checkout to run from instead of this one; its installer/dist must hold the bundle. */
  repo?: string;
}

/** Run the installer with a temp HOME, stub tools first on PATH and a non-TTY stdin. */
export function install(box: Sandbox, args: string[], options: RunOptions = {}): RunResult {
  assertTempHome(box.home);
  const env: Record<string, string> = {
    HOME: box.home,
    TMPDIR: box.root,
    PATH: options.path ?? [box.stubs, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
    STUB_LOG: box.log,
    // The preflight must never look at the host's Homebrew or /usr/local.
    PI_SETUP_SYSTEM_BIN_DIRS: join(box.root, "no-system-bin"),
    STUB_READY: options.ready ?? "anthropic,openai-codex,kimi-coding",
    ...options.env,
  };
  const [cmd, argv] =
    options.entry === "node"
      ? [process.execPath, [join(options.repo ?? REPO, "installer/dist/pi-setup.mjs"), "install", ...args]]
      : ["/bin/bash", [join(REPO, "install.sh"), ...args]];
  const result = spawnSync(cmd, argv, { cwd: options.repo ?? REPO, env, input: "", encoding: "utf8", timeout: 100_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function stubLog(box: Sandbox): string[] {
  return existsSync(box.log) ? readFileSync(box.log, "utf8").split("\n").filter(Boolean) : [];
}

export function homeEntries(box: Sandbox): string[] {
  return readdirSync(box.home);
}

export function piPath(box: Sandbox, ...parts: string[]): string {
  return join(box.home, ".pi", "agent", ...parts);
}

export function installLines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l.startsWith("install "));
}

/** The file paths the last install run logged (per-file lines go to ~/.local/state/pi-setup/install.log, not the screen). */
export function loggedInstalls(box: Sandbox): string[] {
  const log = readFileSync(join(box.home, ".local/state/pi-setup/install.log"), "utf8");
  const last = log.split("# files written").at(-1) ?? "";
  return last.split("\n").filter((l) => l.startsWith("install "));
}

export function findBackups(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.bak-|\.tmp-/.test(e.name)) found.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

/** Every entry below dir: `d`, `f <mode> <sha256> [mtime]` or `l <target>`, keyed by relative path. */
export function snapshot(dir: string, withMtime = false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = p.slice(dir.length + 1);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `l ${readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[rel] = "d";
        walk(p);
      } else {
        const sha = createHash("sha256").update(readFileSync(p)).digest("hex");
        out[rel] = `f ${(st.mode & 0o7777).toString(8)} ${sha}${withMtime ? ` ${st.mtimeMs}` : ""}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** Run folders under ~/.pi/agent/.pi-setup/backups, oldest first. */
export function backupDirs(box: Sandbox): string[] {
  const dir = piPath(box, ".pi-setup", "backups");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** An in-process Ctx rooted in a temp HOME; the Runner is a no-op unless replaced. */
export function testCtx(home: string, over: Partial<Ctx> = {}, lines: string[] = [], errs: string[] = []): Ctx {
  assertTempHome(home);
  return {
    env: {}, platform: "linux", home, cwd: REPO, repoDir: REPO, now: () => new Date(2026, 0, 2, 3, 4, 5),
    run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), which: () => undefined,
    stdinTTY: false, stdoutTTY: false, nodeVersion: "v22.19.0", out: (l) => lines.push(l), err: (l) => errs.push(l),
    ...over,
  };
}

export function tempDir(prefix: string): string {
  return assertTempHome(mkdtempSync(join(tmpdir(), `${prefix}.`)));
}
