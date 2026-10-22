import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite, backupCopy, timestamp } from "./fsx.ts";
import type { Action, Ctx } from "./types.ts";

export interface ApplyOptions {
  dryRun: boolean;
  skipNpm: boolean;
  /** Pass npm's output straight through (not in a spinner, not in --json). */
  inheritNpm: boolean;
  /** Profile to make live, and whether ACTIVE existed before this run. */
  profile: string;
  activeBefore: string | undefined;
  spinner?: { start(message: string): void; stop(message: string): void };
}

export function describe(action: Action): string | undefined {
  if (action.op === "install") return `install ${action.path}`;
  if (action.op === "register") return `register ./local-packages/pi-questions in ${action.path}`;
  return undefined;
}

function writeInstall(action: Extract<Action, { op: "install" }>, stamp: string): void {
  mkdirSync(dirname(action.path), { recursive: true });
  if (action.existed && existsSync(action.path)) backupCopy(action.path, `${action.path}.bak-${stamp}`);
  if (action.path.endsWith("/user.json") || action.path.endsWith("/settings.json")) {
    atomicWrite(action.path, action.content, action.mode);
  } else {
    writeFileSync(action.path, action.content);
    chmodSync(action.path, action.mode);
  }
  if (action.mtimeMs !== undefined) utimesSync(action.path, action.mtimeMs / 1000, action.mtimeMs / 1000);
}

function runAction(action: Action, stamp: string): void {
  if (action.op === "install") {
    writeInstall(action, stamp);
  } else if (action.op === "register") {
    if (action.existed) backupCopy(action.path, `${action.path}.bak-${stamp}`);
    atomicWrite(action.path, action.content, action.mode);
  } else if (action.op === "symlink") {
    mkdirSync(dirname(action.path), { recursive: true });
    try {
      lstatSync(action.path);
    } catch {
      symlinkSync(action.target, action.path);
    }
  } else if (existsSync(action.path) && (statSync(action.path).mode & 0o111) === 0) {
    chmodSync(action.path, statSync(action.path).mode | 0o111);
  }
}

/** Whether this run changed anything pi-profile manages. */
export function touchesProfile(actions: Action[], piDir: string, profile: string): boolean {
  const watched = [join(piDir, "agents"), join(piDir, "workflows"), join(piDir, "profiles", profile), join(piDir, "AGENTS.md")];
  return actions.some((a) => (a.op === "install" || a.op === "register") && watched.some((w) => a.path === w || a.path.startsWith(`${w}/`)));
}

export function needsNpm(actions: Action[], piDir: string): boolean {
  const npmDir = join(piDir, "npm");
  const pkg = join(npmDir, "package.json");
  const lock = join(npmDir, "node_modules", ".package-lock.json");
  if (actions.some((a) => a.op === "install" && a.path === pkg)) return true;
  if (!existsSync(pkg)) return false;
  if (!existsSync(join(npmDir, "node_modules")) || !existsSync(lock)) return true;
  return statSync(pkg).mtimeMs > statSync(lock).mtimeMs;
}

export async function apply(ctx: Ctx, actions: Action[], options: ApplyOptions): Promise<number> {
  const piDir = join(ctx.home, ".pi", "agent");
  const stamp = timestamp(ctx.now());
  for (const action of actions) {
    const line = describe(action);
    if (line) ctx.out(line);
  }
  if (options.dryRun) return 0;
  for (const action of actions) runAction(action, stamp);
  const code = await applyProfile(ctx, actions, options, piDir);
  if (code !== 0) return code;
  return runNpm(ctx, actions, options, piDir);
}

async function applyProfile(ctx: Ctx, actions: Action[], options: ApplyOptions, piDir: string): Promise<number> {
  if (options.activeBefore === undefined) {
    atomicWrite(join(piDir, "profiles", "ACTIVE"), `${options.profile}\n`, 0o644);
    return 0;
  }
  if (options.activeBefore === options.profile && !touchesProfile(actions, piDir, options.profile)) return 0;
  const result = await ctx.run("python3", [join(piDir, "bin", "pi-profile"), "use", options.profile, "--force"], { timeoutMs: 60000 });
  if (result.code !== 0) {
    ctx.err(`pi-profile use ${options.profile} failed: ${(result.stderr || result.stdout).trim()}`);
    return 1;
  }
  return 0;
}

async function runNpm(ctx: Ctx, actions: Action[], options: ApplyOptions, piDir: string): Promise<number> {
  if (options.skipNpm) return 0;
  if (!needsNpm(actions, piDir)) {
    ctx.out("npm packages up to date");
    return 0;
  }
  const args = ["install", "--legacy-peer-deps"];
  const cwd = join(piDir, "npm");
  options.spinner?.start("Installing npm packages");
  const result = await ctx.run("npm", args, { cwd, inherit: options.inheritNpm });
  options.spinner?.stop(result.code === 0 ? "npm packages installed" : "npm install failed");
  if (result.code === 0) return 0;
  if (!options.inheritNpm) ctx.err((result.stdout + result.stderr).trim().split("\n").slice(-15).join("\n"));
  ctx.err("Files installed; npm install failed: (cd ~/.pi/agent/npm && npm install --legacy-peer-deps)");
  return 1;
}

export function readActive(piDir: string): string | undefined {
  const file = join(piDir, "profiles", "ACTIVE");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}
