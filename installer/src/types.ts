export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Pass the child's output straight through to ours (long-running steps such as npm). */
  inherit?: boolean;
}

export type Runner = (cmd: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export interface Ctx {
  env: Record<string, string | undefined>;
  platform: string;
  home: string;
  /** Directory the user ran the command from (relative --repos-root resolves against it). */
  cwd: string;
  /** Root of this pi-setup checkout. */
  repoDir: string;
  now: () => Date;
  run: Runner;
  which: (name: string) => string | undefined;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  nodeVersion: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export class SetupError extends Error {}

export interface Settings {
  githubUser: string;
  reposRoot: string;
}

export type Action =
  | { op: "install"; path: string; content: Buffer; mode: number; mtimeMs?: number; existed: boolean }
  | { op: "register"; path: string; content: Buffer; mode: number; existed: boolean }
  | { op: "symlink"; path: string; target: string }
  | { op: "chmod-x"; path: string };

export interface ProviderState {
  status: "ready" | "not_ready" | "unknown";
  authType?: string;
  reason?: string;
}

export const PROVIDER_IDS = ["anthropic", "openai-codex", "kimi-coding"] as const;
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "ChatGPT",
  "kimi-coding": "Kimi",
};

export interface ToolState {
  name: string;
  path?: string;
  version?: string;
}

export interface GithubState {
  login?: string;
  host?: string;
  orgs: string[];
}

export interface Detection {
  os: string;
  tools: ToolState[];
  github: GithubState;
  providers: Record<string, ProviderState>;
  hints: { codexAuthFile: boolean; claudeDir: boolean };
  /** provider/model ids known to this pi, or null when the catalog is unavailable or empty. */
  catalog: Set<string> | null;
  candidates: { path: string; score: number }[];
  warnings: string[];
}

export interface ProfileMeta {
  name: string;
  summary: string;
  requires: string[];
  uses: string[];
  rank: number;
}

export interface Prompter {
  intro(title: string): void;
  outro(message: string): void;
  note(body: string, title?: string): void;
  spinner(): { start(message: string): void; stop(message: string): void };
  confirm(options: { message: string; initial?: boolean }): Promise<boolean | typeof CANCEL>;
  select<T extends string>(options: {
    message: string;
    options: { value: T; label: string; hint?: string }[];
    initial?: T;
  }): Promise<T | typeof CANCEL>;
  text(options: {
    message: string;
    initial?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string | typeof CANCEL>;
  isCancel(value: unknown): boolean;
}

export const CANCEL: unique symbol = Symbol("pi-setup-cancel");
