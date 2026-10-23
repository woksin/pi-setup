import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realRun, realWhich } from "../context.ts";
import type { Runner } from "../types.ts";

export interface LanesCtx {
  env: Record<string, string | undefined>; platform: string; home: string; cwd: string; now(): Date;
  run: Runner; which(name: string): string | undefined; out(line: string): void; err(line: string): void;
  stdinTTY: boolean; readStdin(): Promise<string>; templatesDir: string; piAgentDir: string;
  loadModule(path: string): Promise<Record<string, unknown>>; realpath(p: string): string; readCwd?(pid: number): Promise<string | undefined>;
}
export function realLanesCtx(): LanesCtx {
  const dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const home = homedir();
  return {
    env: process.env, platform: process.platform, home, cwd: process.cwd(), now: () => new Date(),
    run: realRun, which: realWhich(process.env), out: (s) => console.log(s), err: (s) => console.error(s),
    stdinTTY: Boolean(process.stdin.isTTY), readStdin: async () => { let text = ""; for await (const chunk of process.stdin) text += chunk; return text; },
    templatesDir: [process.env.LANES_TEMPLATES, join(dir, "templates"), join(dir, "../lanes/templates")].find((p) => p && existsSync(p)) || join(dir, "templates"),
    piAgentDir: process.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"),
    loadModule: (p) => import(pathToFileURL(resolve(p)).href), realpath: realpathSync,
  };
}
