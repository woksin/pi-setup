import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { atomicWrite } from "./fsx.ts";
import { deepEqual } from "./settings.ts";
import { SetupError } from "./types.ts";
import type { JsonOp } from "./types.ts";

export interface Source {
  release: string | null;
  commit: string | null;
}

export interface FileEntry {
  sha256: string;
  mode: number;
  source: Source;
  origin: "new" | "adopted" | "replaced";
  /** Relative to .pi-setup/backups/. */
  backup?: string;
  pending?: { path: string; sha256: string };
}

export interface JsonEntry {
  created: boolean;
  backup?: string;
  sha256After: string;
  ops: JsonOp[];
}

export interface Manifest {
  version: 1;
  installedAt: string;
  updatedAt: string;
  source: Source;
  files: Record<string, FileEntry>;
  symlinks: Record<string, { target: string }>;
  dirs: string[];
  json: Record<string, JsonEntry>;
}

export const noSource = (): Source => ({ release: null, commit: null });
export const dataDir = (piDir: string): string => join(piDir, ".pi-setup");
export const manifestPath = (piDir: string): string => join(dataDir(piDir), "manifest.json");
export const backupsDir = (piDir: string): string => join(dataDir(piDir), "backups");

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function emptyManifest(now: Date): Manifest {
  const stamp = now.toISOString();
  return { version: 1, installedAt: stamp, updatedAt: stamp, source: noSource(), files: {}, symlinks: {}, dirs: [], json: {} };
}

/** Never recorded and never touched by uninstall: credentials, runtime state and pi-setup's own data. */
const DENY_FILES = ["auth.json", "auth.json.lock", "models-store.json", "guards.json", "lane-policy/policy.json"];
const DENY_DIRS = ["accounts", "sessions", "jobs", "relaunch", "context-budget", "pi-phase/state", "npm/node_modules", ".pi-setup"];

function problemWith(rel: unknown): string | undefined {
  if (typeof rel !== "string" || rel === "") return "empty path";
  if (rel.includes("\0") || rel.includes("\\")) return "invalid character";
  if (isAbsolute(rel)) return "absolute path";
  if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) return "path escapes its directory";
  const prefix = ".pi/agent/";
  if (rel.startsWith(prefix)) {
    const sub = rel.slice(prefix.length);
    if (DENY_FILES.includes(sub) || DENY_DIRS.some((d) => sub === d || sub.startsWith(`${d}/`))) return "protected path";
  }
  return undefined;
}

/** Absolute path for a HOME-relative manifest path; refuses anything that could point outside what pi-setup owns. */
export function fromHomeRel(home: string, rel: string): string {
  const problem = problemWith(rel);
  if (problem) throw new SetupError(`manifest path rejected (${problem}): ${String(rel)}`);
  return join(home, rel);
}

export function homeRel(home: string, abs: string): string {
  const rel = relative(home, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new SetupError(`${abs} is outside ${home}`);
  return rel.split("\\").join("/");
}

export function checkBackupRel(rel: unknown): string {
  if (typeof rel !== "string" || rel === "" || isAbsolute(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new SetupError(`manifest backup path rejected: ${String(rel)}`);
  }
  return rel;
}

/** Check every path in the manifest; throws before anything is touched. */
export function validateManifest(home: string, m: Manifest): void {
  for (const [rel, e] of Object.entries(m.files)) {
    fromHomeRel(home, rel);
    if (e.pending) fromHomeRel(home, e.pending.path);
    if (e.backup !== undefined) checkBackupRel(e.backup);
  }
  for (const [rel, l] of Object.entries(m.symlinks)) {
    fromHomeRel(home, rel);
    fromHomeRel(home, l.target);
  }
  for (const rel of m.dirs) fromHomeRel(home, rel);
  for (const [rel, j] of Object.entries(m.json)) {
    fromHomeRel(home, rel);
    if (j.backup !== undefined) checkBackupRel(j.backup);
  }
}

export function readManifest(piDir: string): Manifest | undefined {
  const path = manifestPath(piDir);
  if (!existsSync(path)) return undefined;
  const bad = (why: string) => new SetupError(`${path}: ${why}; move it aside to re-adopt your files with ./install.sh`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw bad((error as Error).message);
  }
  const m = data as Partial<Manifest> | null;
  const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(m) || m!.version !== 1 || !isObject(m!.files) || !isObject(m!.symlinks) || !isObject(m!.json) || !Array.isArray(m!.dirs)) {
    throw bad("not a version 1 manifest");
  }
  return m as Manifest;
}

/** Write only when something besides updatedAt differs. Returns whether it wrote. */
export function saveIfChanged(piDir: string, old: Manifest | undefined, next: Manifest, now: Date): boolean {
  const strip = (m: Manifest) => JSON.stringify({ ...m, updatedAt: "" });
  if (old && strip(old) === strip(next)) return false;
  next.updatedAt = now.toISOString();
  atomicWrite(manifestPath(piDir), `${JSON.stringify(next, null, 2)}\n`, 0o644);
  return true;
}

export function pinnedBackups(m: Manifest | undefined): Set<string> {
  const pinned = new Set<string>();
  for (const e of Object.values(m?.files ?? {})) if (e.backup) pinned.add(e.backup);
  for (const e of Object.values(m?.json ?? {})) if (e.backup) pinned.add(e.backup);
  return pinned;
}

/** The first recorded `before` wins; `after` follows the latest run. */
export function recordSet(entry: JsonEntry, op: Extract<JsonOp, { op: "set" }>): void {
  const i = entry.ops.findIndex((o) => o.op === "set" && o.key === op.key);
  const prior = entry.ops[i];
  if (prior?.op === "set") entry.ops[i] = { ...op, before: prior.before };
  else entry.ops.push(op);
}

export function recordArrayAdd(entry: JsonEntry, op: Extract<JsonOp, { op: "array-add" }>): void {
  const known = entry.ops.some((o) => o.op === "array-add" && o.key === op.key && deepEqual(o.value, op.value));
  if (!known) entry.ops.push(op);
}
