import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { EvidenceContext, Signals } from "./signals.ts";

export const HEADINGS = ["Goal", "Repository", "Worktree", "Branch", "HEAD", "Dirty files", "Issue claims",
  "Open PRs or candidates", "External work", "Next step", "User constraints", "Open items", "Launch prompt"];
export interface Snapshot { head: string; paths: string[]; digest?: string; unpushed: string[]; repo?: string; worktree: string; branch?: string }
export interface ContextFile { text: string; snapshot: Snapshot; mtime: number; digest: string }
function sections(text: string): Map<string, string> {
  const matches = [...text.matchAll(/^##\s+([^\r\n]+)\r?$/gm)]; const result = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]; const end = matches[i + 1]?.index ?? text.length;
    result.set(match[1].trim().toLowerCase(), text.slice(match.index! + match[0].length, end).trim());
  }
  return result;
}
function snapshotSection(section: string | undefined): Snapshot {
  const json = section?.match(/^```json\s*\n([\s\S]*?)\n```\s*$/)?.[1];
  if (!json) throw new Error("lane handoff requires a JSON Snapshot section");
  const snapshot = JSON.parse(json);
  if (!validSnapshot(snapshot)) throw new Error("lane handoff Snapshot invalid"); return snapshot;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(s => typeof s === "string");
}
function optionalIdentity(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && Boolean(value));
}
function validSnapshot(s: Snapshot): boolean {
  if (!s || !/^[a-f0-9]{40,64}$/.test(s.head)) return false;
  if (!strings(s.paths) || !strings(s.unpushed)) return false;
  return typeof s.worktree === "string" && Boolean(s.worktree)
    && [s.repo, s.branch].every(optionalIdentity);
}
export function readContext(path: string): ContextFile {
  const stat = lstatSync(path); if (!stat.isFile()) throw new Error("lane handoff must be a regular file");
  const text = readFileSync(path, "utf8"); const parts = sections(text);
  for (const heading of HEADINGS) {
    if (!parts.get(heading.toLowerCase())) throw new Error(`lane handoff missing ${heading}`);
  }
  return { text, snapshot: snapshotSection(parts.get("snapshot")), mtime: stat.mtimeMs,
    digest: createHash("sha256").update(text).digest("hex") };
}
export function expectedSnapshot(env: EvidenceContext, s: Signals): Snapshot {
  return { head: s.git.head!, paths: s.git.paths!, digest: s.git.digest, unpushed: s.git.unpushed!, repo: env.lane.repo,
    worktree: s.cwd, branch: env.lane.branch };
}
export function validateContext(file: ContextFile, expected: Snapshot): void {
  const actual = file.snapshot;
  if (actual.head !== expected.head) throw new Error("lane handoff HEAD differs from worktree");
  validateDirty(actual, expected);
  if (!samePaths(actual.unpushed, expected.unpushed)) throw new Error("lane handoff unpushed commits differ");
  validateLocation(actual, expected);
}
function validateDirty(actual: Snapshot, expected: Snapshot): void {
  if (!samePaths(actual.paths, expected.paths)) throw new Error("lane handoff has unaccounted dirty files");
  if (actual.digest !== expected.digest) throw new Error("lane handoff dirty digest differs from worktree");
}
function validateLocation(actual: Snapshot, expected: Snapshot): void {
  for (const key of ["repo", "worktree", "branch"] as const) {
    if (actual[key] !== expected[key]) throw new Error(`lane handoff ${key} differs`);
  }
}
function samePaths(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}
