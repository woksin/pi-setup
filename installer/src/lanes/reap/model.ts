import type { Config, Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import type { GitEvidence } from "./git.ts";
import type { DecisionSignals } from "./verdict.ts";
export interface Claim { repo: string; issue: number; sessionId: string; cwd?: string; source: string; state?: string; note?: string; pr?: string }
export interface Signals extends DecisionSignals {
  id: string; cwd: string; pid?: number; pids: number[]; sessionId?: string; sessionFile?: string; lastWrite?: number; procStart?: string; tty?: string;
  claims: Claim[]; git: GitEvidence; unread: string[]; status?: string;
}
export interface EvidenceContext { c: Config; lane: Lane; root: string; ctx: LanesCtx; minutes: number }
