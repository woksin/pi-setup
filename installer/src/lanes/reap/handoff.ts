import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backendFor } from "../backend.ts";
import { effectiveParent, expand, UsageError, type Config, type Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { atomicJson, optionalText } from "./files.ts";
import { processIds, absolute } from "./process.ts";
import { collect, type EvidenceContext, type Signals } from "./signals.ts";
export interface Handoff {
  version: 1; id: string; from: string; to: string; at: string; fingerprint: string; signals: Signals;
  requestMessage?: string; acceptance?: { from: string; at: string; fingerprint: string };
}
export function fingerprint(s: Signals): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex");
}
export function packPath(env: Pick<EvidenceContext, "root" | "lane">): string {
  return join(env.root, ".state/handoffs", env.lane.id);
}
export function readPack(env: Pick<EvidenceContext, "root" | "lane">): Handoff | undefined {
  const text = optionalText(join(packPath(env), "handoff.json"));
  if (text === undefined) return undefined;
  const value = JSON.parse(text);
  if (!validPack(value, env.lane.id)) throw new Error("invalid handoff pack"); return value;
}
export async function recipient(env: EvidenceContext, to: string): Promise<void> {
  const { c, lane, root, ctx } = env;
  const target = c.lanes.find(l => l.id === to && !l.retired);
  validateRecipient({ to, target }, env);
  const cwd = recipientCwd(env, target);
  if ((await processIds(ctx, absolute(ctx, cwd))).length !== 1) {
    throw new UsageError("handoff recipient is not live or has shared cwd");
  }
}
export async function prepare(env: EvidenceContext, to: string, s: Signals): Promise<Handoff> {
  const { c, lane, root, ctx } = env;
  await recipient(env, to);
  if (s.asks.length || s.keeps.length) throw new Error(`handoff blocked: ${[...s.asks, ...s.keeps].join("; ")}`);
  const hash = fingerprint(s); const old = readPack(env);
  if (reusable(old, hash, to)) return old!;
  const dir = packPath(env); mkdirSync(dir, { recursive: true });
  const pack: Handoff = { version: 1, id: `${lane.id}-${hash.slice(0, 12)}`, from: lane.id, to,
    at: ctx.now().toISOString(), fingerprint: hash, signals: s };
  const notes = ["NOW.md", "WATCHES.md", "STATE.md"].map(n =>
    `## ${n}\n${optionalText(join(root, "coordinator", n)) || "unknown/not present"}`).join("\n\n");
  writeFileSync(join(dir, "HANDOFF.md"), [
    `# Handoff ${pack.id}`,
    `Recipient: ${to}`,
    `Branch: ${lane.branch}`,
    `SHA: ${s.git.head || "unknown"}`,
    `Dirty: ${s.git.dirty}`,
    `Ahead: ${s.git.ahead ?? "unknown"}`,
    `Uncommitted paths: ${JSON.stringify(s.git.paths)}`,
    `Unpushed commits: ${JSON.stringify(s.git.unpushed)}`,
    `Tree digest: ${s.git.digest}`,
    `PR merged at HEAD: ${s.git.merged ?? "unknown"}`,
    ``,
    `## Claims`,
    `${JSON.stringify(s.claims, null, 2)}`,
    ``,
    `## Deliveries / pending acknowledgements / candidate ownership`,
    `Unknown: file messages are not machine-readable acknowledgements. Recipient must take these over ` +
      `explicitly.`,
    ``,
    `## Next action`,
    `Review claims, branch, preserved worktree and pending acknowledgements. Accept using lanes handoff ` +
      `${lane.id} --accept --from ${to}. Never mark claims done just to retire.`,
    ``,
    `${notes}`,
    ``,
  ].join("\n"));
  atomicJson(join(dir, "handoff.json"), pack);
  const message = await backendFor(c, ctx, root).send({
    from: c.coordinator.id, to, topic: "handoff-request",
    body: `Review ${join(dir, "HANDOFF.md")} and ${join(dir, "handoff.json")}. ` +
      `Explicitly accept with: lanes handoff ${lane.id} --accept --from ${to}. ` +
      "This transfers next-action and pending acknowledgement ownership; it does not complete claims.",
  });
  pack.requestMessage = message.name; atomicJson(join(dir, "handoff.json"), pack); return pack;
}
export async function accept(env: EvidenceContext, from: string): Promise<Handoff> {
  const { lane, ctx } = env;
  validateAcceptanceIdentity(env, from);
  const pack = readPack(env);
  if (!pack || pack.to !== from) throw new UsageError("acceptance must come from the named handoff recipient");
  await recipient(env, from);
  const current = await collect(env);
  if (fingerprint(current) !== pack.fingerprint) {
    throw new Error("handoff evidence changed; prepare a new pack before accepting");
  }
  pack.acceptance = { from, at: ctx.now().toISOString(), fingerprint: pack.fingerprint };
  atomicJson(join(packPath(env), "handoff.json"), pack); return pack;
}
export function handoffRecipient(lane: Lane, c: Config, override?: string): string {
  return override || effectiveParent(lane, c);
}

function recipientCwd(env: EvidenceContext, target: Lane | undefined): string {
  const { c, root, ctx } = env;
  return target ? join(expand(c.worktreesDir, c, root, ctx.home), target.worktree)
    : expand(c.coordinator.cwd, c, root, ctx.home);
}
function validPack(value: Handoff, id: string): boolean {
  return value.version === 1 && value.from === id && typeof value.fingerprint === "string";
}
function reusable(pack: Handoff | undefined, hash: string, to: string): boolean {
  if (!pack?.requestMessage) return false;
  return pack.fingerprint === hash && pack.to === to;
}

function validateRecipient(input: { to: string; target?: Lane }, env: EvidenceContext): void {
  const error = "handoff recipient must be another active lane or coordinator";
  if (input.to === env.lane.id) throw new UsageError(error);
  if (!input.target && input.to !== env.c.coordinator.id) throw new UsageError(error);
}

function validateAcceptanceIdentity(env: EvidenceContext, from: string): void {
  const caller = env.ctx.env.PI_ORCH_ID;
  if (caller && caller !== from) throw new UsageError("--from must match PI_ORCH_ID");
}
