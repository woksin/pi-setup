import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SetupError } from "./types.ts";
import type { Settings } from "./types.ts";

export type UserSource = "flag" | "saved" | "detected" | "prompt" | "placeholder";
export type RootSource = "flag" | "saved" | "scan" | "default" | "prompt";

export interface ResolvedSettings extends Settings {
  userSource: UserSource;
  rootSource: RootSource;
  warnings: string[];
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const FORBIDDEN_ROOT = /[\n\r\0"'$`\\]/;

export function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SetupError(`${path}: ${(error as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SetupError(`${path}: expected a JSON object`);
  }
  const record = data as Record<string, unknown>;
  for (const key of ["githubUser", "reposRoot"]) {
    const value = record[key];
    if (key in record && (typeof value !== "string" || !value.trim())) {
      throw new SetupError(`${path}: ${key} must be a nonempty string`);
    }
  }
  return record;
}

export function validLogin(login: string): boolean {
  return LOGIN.test(login);
}

/** Expand a leading `~` or `~/`; `~user` is not supported. */
export function expandHome(value: string, home = homedir()): string {
  if (value === "~") return home;
  return value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
}

export function normalizeRoot(value: string, home: string, base: string): string {
  const root = resolve(base, expandHome(value, home));
  if (FORBIDDEN_ROOT.test(root)) {
    throw new SetupError("Repositories root must be a single-line path without quotes, $, backticks or backslashes.");
  }
  return root;
}

export interface SettingsInput {
  flagUser: string;
  flagRoot: string;
  saved: Record<string, unknown>;
  detectedUser?: string;
  scanRoot?: string;
  home: string;
  repoDir: string;
  readOnly?: boolean;
}

export const PLACEHOLDER_LOGIN = "<you>";

export function resolveSettings(input: SettingsInput): ResolvedSettings {
  const savedUser = typeof input.saved.githubUser === "string" ? input.saved.githubUser : "";
  const savedRoot = typeof input.saved.reposRoot === "string" ? input.saved.reposRoot : "";
  const picked = pick<UserSource>([
    [input.flagUser, "flag"], [savedUser, "saved"], [input.detectedUser ?? "", "detected"],
  ]);
  const placeholder = !picked[0] && input.readOnly === true;
  const [githubUser, userSource]: [string, UserSource] = placeholder ? [PLACEHOLDER_LOGIN, "placeholder"] : picked;
  if (!placeholder && !githubUser) throw new SetupError("Cannot determine GitHub login; pass --user <login> (or authenticate gh).");
  if (!placeholder && !validLogin(githubUser)) throw new SetupError("Invalid GitHub login; pass --user <login>.");
  const [rawRoot, rootSource] = pick<RootSource>([
    [input.flagRoot, "flag"], [savedRoot, "saved"], [input.scanRoot ?? "", "scan"], [`${input.home}/repos`, "default"],
  ]);
  const reposRoot = normalizeRoot(rawRoot, input.home, input.repoDir);
  const warnings = /\s/.test(reposRoot)
    ? [`Repositories root contains a space (${reposRoot}); shell scripts in bin/ may not quote it.`]
    : [];
  if (placeholder) warnings.push(`No GitHub login found, so names show ${PLACEHOLDER_LOGIN}; pass --user <login> to see the final names.`);
  return { githubUser, reposRoot, userSource, rootSource, warnings };
}

function pick<S extends string>(choices: [string, S][]): [string, S] {
  return choices.find(([value]) => value) ?? ["", choices[choices.length - 1][1]];
}

export function render(buf: Buffer, settings: Settings): Buffer {
  const text = buf.toString("utf8")
    .split("{{GITHUB_USER}}").join(settings.githubUser)
    .split("{{REPOS_ROOT}}").join(settings.reposRoot);
  return Buffer.from(text, "utf8");
}

export function hasTokens(buf: Buffer): boolean {
  return buf.includes("{{GITHUB_USER}}") || buf.includes("{{REPOS_ROOT}}");
}

/** user.json owns exactly githubUser and reposRoot; every other key is kept in place. */
export function mergeUserJson(existing: Record<string, unknown>, settings: Settings): Record<string, unknown> {
  return { ...existing, githubUser: settings.githubUser, reposRoot: settings.reposRoot };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}
