import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expand } from "../config.ts";
import { parseMessageName } from "../names.ts";
import { optionalText } from "./files.ts";
import { claimMapsToLane, registry } from "./ownership.ts";
import type { Claim, CommandEnv, Signals } from "./signals.ts";

export interface Summary { label: string; names: string[] }
export function summaryLine({ label, names }: Summary): string {
  const suffix = names.length > 10 ? ` (+${names.length - 10} more)` : "";
  return `${label} (${names.length}): ${names.slice(0, 10).join(", ")}${suffix}`;
}
function mapped(claim: Claim, signals: Signals[], env: CommandEnv): boolean {
  return signals.some(signal => {
    const lane = env.c.lanes.find(lane => lane.id === signal.id);
    return lane !== undefined && claimMapsToLane(claim, signal, lane);
  });
}
export function summary(signals: Signals[], env: CommandEnv): Summary[] {
  const result: Summary[] = [];
  const dir = expand(env.c.messages.dir, env.c, env.root, env.ctx.home);
  const names = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".md") && !parseMessageName(name)) : [];
  if (names.length) result.push({ label: "Unparseable messages", names });
  const text = optionalText(join(env.ctx.piAgentDir, "issue-work/registry.jsonl"));
  try {
    const foreign = registry(text ?? "").filter(claim => !mapped(claim, signals, env));
    if (foreign.length) result.push({ label: "Foreign claims", names: foreign.map(claim => `${claim.repo}#${claim.issue}`) });
  } catch { result.push({ label: "Claim summary unavailable", names: ["cannot read issue-work registry"] }); }
  return result;
}
