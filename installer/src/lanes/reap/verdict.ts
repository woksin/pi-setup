/** Pure: live activity wins; uncertainty remains visible and blocks destructive action. */
export interface DecisionSignals { asks: string[]; keeps: string[]; finished: boolean; takeover: boolean; helpers?: string[] }
export interface Decision { verdict: "keep" | "ask" | "handoff" | "retire"; ground?: "finished" | "takeover"; reason: string; notes?: string[] }
export function topReasons(reasons: string[]): string {
  return [...new Set(reasons)].slice(0, 3).join("; ");
}
function liveActivity(reasons: string[]): boolean {
  const live = new Set(["subagent running", "busy child process", "job/watch running (log open)", "job/watch running (session snapshot)"]);
  return reasons.some(reason => live.has(reason));
}
function keep(s: DecisionSignals): Decision {
  return { verdict: "keep", reason: topReasons(s.keeps), notes: [...new Set(s.asks)] };
}
export function verdict(s: DecisionSignals): Decision {
  const result = decide(s);
  if (!s.helpers?.length) return result;
  const kinds = [...new Set(s.helpers)].sort().map(kind => `${kind}=${s.helpers!.filter(value => value === kind).length}`);
  return { ...result, notes: [...(result.notes ?? []), `helpers (${s.helpers.length}): ${kinds.join(", ")}`] };
}
function decide(s: DecisionSignals): Decision {
  if (liveActivity(s.keeps)) return keep(s);
  if (s.asks.length) return { verdict: "ask", reason: topReasons(s.asks) };
  if (s.keeps.length) return keep(s);
  if (s.finished) return { verdict: "retire", ground: "finished", reason: "finished: all machine evidence proves completion" };
  if (s.takeover) return { verdict: "retire", ground: "takeover", reason: "takeover validated" };
  return { verdict: "handoff", reason: "idle; delivery acknowledgements and candidate ownership unknown; takeover required" };
}
