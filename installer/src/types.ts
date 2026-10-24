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
  /** Node binary used to re-run the installer after `update` (default: process.execPath). */
  nodePath?: string;
  /** OS account home, independent of HOME; injectable for service tests. */
  userHome?: string;
  noLaunchd?: boolean;
}

export class SetupError extends Error {}

export interface Settings {
  githubUser: string;
  reposRoot: string;
}

/** One reversible change to a JSON file that pi-setup merged into rather than owns. */
export type JsonOp =
  | { op: "set"; key: string; before: { present: boolean; value?: unknown }; after: unknown }
  | { op: "array-add"; key: string; value: unknown; keyCreated: boolean }
  | { op: "array-replace"; key: string; before: unknown; after: unknown };

export type Decision = "new" | "update" | "replace" | "take";

export type Action =
  | {
      op: "install"; path: string; content: Buffer; mode: number; mtimeMs?: number; existed: boolean;
      decision?: Decision; merge?: "user-json"; jsonOps?: JsonOp[];
      /** AGENTS.md without routing markers on disk: never overwritten silently, reconciled as a whole file. */
      noMarkers?: boolean;
    }
  | { op: "register"; path: string; content: Buffer; mode: number; existed: boolean; jsonOps?: JsonOp[] }
  /** On disk and identical to the repo: nothing to write, only to record. */
  | { op: "adopt"; path: string }
  /** Changed by the user since the last install: keep it, offer the new version as <path>.pi-setup-new. */
  | { op: "keep"; path: string; newPath: string; content: Buffer; mode: number; mtimeMs?: number; write: boolean; noMarkers?: boolean }
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
  step?(index: number, total: number, title: string): void;
  spinner(): { start(message: string): void; stop(message: string): void };
  confirm(options: { message: string; initial?: boolean }): Promise<boolean | typeof CANCEL>;
  select<T extends string>(options: {
    message: string;
    options: { value: T; label: string; hint?: string; disabled?: boolean }[];
    initial?: T;
  }): Promise<T | typeof CANCEL>;
  text(options: {
    message: string;
    initial?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string | typeof CANCEL>;
  multiselect<T extends string>(options: {
    message: string;
    options: { value: T; label: string; hint?: string }[];
    initial: T[];
  }): Promise<T[] | typeof CANCEL>;
  isCancel(value: unknown): boolean;
}

export const CANCEL: unique symbol = Symbol("pi-setup-cancel");
