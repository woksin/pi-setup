import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { backendFor } from "../backend.ts";
import { effectiveParent } from "../config.ts";
import { registry } from "./ownership.ts";
import { optionalText } from "./files.ts";
import { contextPath } from "./own-context.ts";
import type { EvidenceContext, Signals } from "./signals.ts";

export interface Closure { id: string; ground: "takeover"; verdict: "retire"; ts: string; sha?: string;
  sessionFile?: string; handoff: string; evidence: string; archive: string; to: string }
function pauseClaims(env: EvidenceContext, s: Signals, record: Closure): void {
  const path = join(env.ctx.piAgentDir, "issue-work/registry.jsonl");
  const latest = registry(optionalText(path) || "");
  for (const claim of s.claims.filter(claim => claim.state !== "done")) {
    const current = latest.find(value => value.repo.toLowerCase() === claim.repo.toLowerCase() &&
      value.issue === claim.issue);
    if (JSON.stringify(current) !== JSON.stringify(claim)) throw new Error("claim changed before pause; inspect closure");
    const event = { ...claim, ts: record.ts, state: "paused", sessionFile: s.sessionFile,
      note: `Paused by lanes reap; takeover by ${record.to}; handoff: ${record.handoff}` };
    appendFileSync(path, `\n${JSON.stringify(event)}\n`);
  }
}
export async function recordClosure(env: EvidenceContext, s: Signals, target: { to: string; archive: string }): Promise<void> {
  const { root, lane, c, ctx } = env;
  const record: Closure = { id: lane.id, ground: "takeover", verdict: "retire", ts: ctx.now().toISOString(),
    sha: s.git.head, sessionFile: s.sessionFile, handoff: contextPath(env), archive: target.archive, to: target.to,
    evidence: `Accepted takeover; clean foreground /quit and exit confirmed; tree=${s.git.digest}` };
  pauseClaims(env, s, record);
  mkdirSync(join(root, "coordinator"), { recursive: true });
  appendFileSync(join(root, "coordinator/STATE.md"),
    `\n- ${record.ts} ${lane.id}: takeover by ${target.to}; handoff ${record.handoff}; SHA ${record.sha}.\n`);
  appendFileSync(join(root, ".state/reaped.log"), `${JSON.stringify(record)}\n`);
  await backendFor(c, ctx, root).send({ from: lane.id, to: effectiveParent(lane, c), topic: "lane-closed",
    body: `${lane.id} closed (takeover by ${target.to}). Handoff: ${record.handoff}. Archive: ${target.archive}.` });
}
