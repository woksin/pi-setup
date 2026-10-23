import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expand } from "../config.ts";
import { parseMessageName } from "../names.ts";
import { optionalText } from "./files.ts";
import { registry } from "./ownership.ts";
import type { CommandEnv, Signals } from "./signals.ts";

export function summary(signals: Signals[], env: CommandEnv): string[] {
  const result: string[] = [];
  const dir = expand(env.c.messages.dir, env.c, env.root, env.ctx.home);
  const names = existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".md") && !parseMessageName(name)) : [];
  if (names.length) result.push(`Unparseable messages (${names.length}): ${names.join(", ")}`);
  const text = optionalText(join(env.ctx.piAgentDir, "issue-work/registry.jsonl"));
  try {
    const sessions = new Set(signals.map(signal => signal.sessionId));
    const foreign = registry(text ?? "").filter(claim => !sessions.has(claim.sessionId));
    if (foreign.length) result.push(`Foreign claims (${foreign.length}): ${foreign.map(claim => `${claim.repo}#${claim.issue}`).join(", ")}`);
  } catch { result.push("Claim summary unavailable: cannot read issue-work registry"); }
  return result;
}
