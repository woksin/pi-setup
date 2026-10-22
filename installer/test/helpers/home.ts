import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  script(box.stubs, "pi", `echo "pi $*" >> "$STUB_LOG"
case "$1" in
  --version) echo 1.4.0; exit 0 ;;
  auth)
    case ",$STUB_READY," in
      *",$4,"*) echo "{\\"status\\":\\"ready\\",\\"provider\\":\\"$4\\",\\"authType\\":\\"oauth\\"}"; exit 0 ;;
      *) echo "{\\"status\\":\\"not_ready\\",\\"provider\\":\\"$4\\",\\"reason\\":\\"credentials_not_configured\\"}"; exit 1 ;;
    esac ;;
  --offline) echo "No models available. Use /login to log into a provider."; exit 0 ;;
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
: > node_modules/.package-lock.json`);
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
