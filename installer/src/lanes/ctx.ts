import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realRun, realWhich } from "../context.ts";
import type { Runner } from "../types.ts";
import type { ProcessSample } from "./reap/work.ts";
import type { AdmissionProcess } from "./admission.ts";
export interface InheritedChild {
  pid: number; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal(signal: NodeJS.Signals): void;
}

export interface LanesCtx {
  env: Record<string, string | undefined>; platform: string; home: string; cwd: string; now(): Date;
  run: Runner; which(name: string): string | undefined; out(line: string): void; err(line: string): void;
  sleep?(ms: number): Promise<void>;
  processInventory?(): Promise<ProcessSample[]>;
  admissionInventory?(): Promise<AdmissionProcess[]>;
  spawnInherited?(exe: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): InheritedChild;
  launcher?: string[];
  stdinTTY: boolean; readStdin(): Promise<string>; templatesDir: string; piAgentDir: string;
  loadModule(path: string): Promise<Record<string, unknown>>; realpath(p: string): string; readCwd?(pid: number): Promise<string | undefined>;
}
export function realLanesCtx(): LanesCtx {
  const dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const home = homedir();
  return {
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    launcher: [process.execPath, dir.endsWith("/src/lanes") ? join(dir, "cli.ts") : join(dir, "lanes.mjs")],
    env: process.env, platform: process.platform, home, cwd: process.cwd(), now: () => new Date(),
    run: realRun, which: realWhich(process.env), out: (s) => console.log(s), err: (s) => console.error(s),
    stdinTTY: Boolean(process.stdin.isTTY), readStdin: async () => { let text = ""; for await (const chunk of process.stdin) text += chunk; return text; },
    templatesDir: [process.env.LANES_TEMPLATES, join(dir, "templates"), join(dir, "../lanes/templates")].find((p) => p && existsSync(p)) || join(dir, "templates"),
    piAgentDir: process.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"),
    loadModule: (p) => import(pathToFileURL(resolve(p)).href), realpath: realpathSync,
  };
}
