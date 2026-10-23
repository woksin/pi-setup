/** Pure: uncertainty wins; elapsed time is never evidence of completed work. */
export interface DecisionSignals { asks: string[]; keeps: string[]; finished: boolean; takeover: boolean }
export interface Decision { verdict: "keep" | "ask" | "handoff" | "retire"; ground?: "finished" | "takeover"; reason: string }
export function topReasons(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].slice(0, 3).map(([reason, count]) => count > 1 ? `${count}× ${reason}` : reason).join("; ");
}
export function verdict(s: DecisionSignals): Decision {
  if (s.asks.length) return { verdict: "ask", reason: topReasons(s.asks) };
  if (s.keeps.length) return { verdict: "keep", reason: topReasons(s.keeps) };
  if (s.finished) return { verdict: "retire", ground: "finished", reason: "finished: all machine evidence proves completion" };
  if (s.takeover) return { verdict: "retire", ground: "takeover", reason: "takeover validated" };
  return { verdict: "handoff", reason: "idle; delivery acknowledgements and candidate ownership unknown; takeover required" };
}
