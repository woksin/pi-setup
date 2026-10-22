import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Ctx, Runner, RunOptions, RunResult } from "./types.ts";

const MAX_BUFFER = 16 * 1024 * 1024;

function inherited(cmd: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
    child.on("error", (error) => resolve({ code: null, stdout: "", stderr: error.message, timedOut: false }));
    child.on("close", (code) => resolve({ code, stdout: "", stderr: "", timedOut: false }));
  });
}

export const realRun: Runner = (cmd, args, options = {}) => {
  if (options.inherit) return inherited(cmd, args, options);
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: options.cwd, env: { ...process.env, ...options.env }, timeout: options.timeoutMs, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const code = failure ? (typeof failure.code === "number" ? failure.code : null) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: failure && code === null && !stderr ? failure.message : String(stderr ?? ""),
          timedOut: Boolean(failure?.killed),
        });
      },
    );
    child.stdin?.end();
  });
};

export function realWhich(env: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name) => {
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
    return undefined;
  };
}

export function realContext(repoDir: string): Ctx {
  return {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    repoDir,
    nodePath: process.execPath,
    now: () => new Date(),
    run: realRun,
    which: realWhich(process.env),
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    nodeVersion: process.version,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}
