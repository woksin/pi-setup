import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { recordClosure } from "./closure.ts";
import { contextPath } from "./own-context.ts";
import { effectiveParent, expand, saveConfig, type Config, type Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { parseMessageName } from "../names.ts";
import { atomicJson } from "./files.ts";
import { packPath } from "./handoff.ts";
import type { EvidenceContext, Signals } from "./signals.ts";
export function checkRetirement(lane: Lane, c: Config, root: string): void {
  if (c.lanes.some(l => !l.retired && effectiveParent(l, c) === lane.id)) throw new Error("retirement would orphan active children; reparent first");
  const prompt = relative(root, resolve(root, lane.prompt));
  if (prompt.startsWith("..") || isAbsolute(prompt)) throw new Error("prompt outside coordination root cannot be archived");
}
/** Copy first: a failed archive never removes an active lane's source files. */
export async function archive(env: EvidenceContext, s: Signals, to: string): Promise<string> {
  const { c, lane, root, ctx } = env;
  checkRetirement(lane, c, root);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, "-"); const dest = join(root, ".state/retired", stamp, lane.id);
  if (existsSync(join(dest, "closure.json"))) throw new Error("retirement archive already exists; inspect before retrying");
  const dir = expand(c.messages.dir, c, root, ctx.home); const sources: { path: string; dest: string; body?: Buffer }[] = [];
  const add = (path: string, target: string) => { if (existsSync(path)) sources.push({ path, dest: join(dest, target) }); };
  add(resolve(root, lane.prompt), `prompts/${lane.id}.md`); add(join(dir, "status", `${lane.id}.status`), `messages/status/${lane.id}.status`); add(join(dir, `${lane.id}-inbox.marker`), `messages/${lane.id}-inbox.marker`);
  for (const name of readdirSync(dir)) {
    const parsed = parseMessageName(name);
    if (laneAddressed(parsed, lane)) add(join(dir, name), `messages/${name}`);
  }
  const handoff = packPath({ root, lane });
  if (existsSync(handoff)) for (const name of readdirSync(handoff)) add(join(handoff, name), `handoff/${name}`);
  mkdirSync(dest, { recursive: true }); atomicJson(join(dest, "lane.json"), lane);
  sources.forEach(copySource);
  copySource({ path: contextPath(env), dest: join(dest, "handoff", `${lane.id}.md`) });
  const closure = { id: lane.id, at: ctx.now().toISOString(), ground: "takeover", to, signals: s, worktreePreserved: s.cwd, branchPreserved: lane.branch };
  atomicJson(join(dest, "closure.json"), closure);
  await recordClosure(env, s, { to, archive: dest });
  lane.retired = true; lane.stateFile = relative(root, join(dest, "closure.json")); saveConfig(root, c);
  sources.forEach(removeUnchanged);

  return dest;
}

interface Source { path: string; dest: string; body?: Buffer }
function copySource(source: Source): void {
  if (!lstatSync(source.path).isFile()) throw new Error(`archive source is not a regular file: ${source.path}`);
  source.body = readFileSync(source.path); mkdirSync(dirname(source.dest), { recursive: true }); copyFileSync(source.path, source.dest);
}
function removeUnchanged(source: Source): void {
  if (source.body && readFileSync(source.path).equals(source.body)) unlinkSync(source.path);
}

function laneAddressed(parsed: ReturnType<typeof parseMessageName>, lane: Lane): boolean {
  if (!parsed) return false;
  return parsed.to.length === 1 && parsed.to[0] === lane.id;
}
