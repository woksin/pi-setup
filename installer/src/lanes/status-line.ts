export function parseStatus(line: string = ""): { kind: "working" | "waiting-on" | "barred-by" | "closed" | "other"; until?: number } {
  const match = /^(waiting-on|barred-by) "(.*)" until (\S+)$/.exec(line);
  if (match) return { kind: match[1] as "waiting-on" | "barred-by", until: Date.parse(match[3]) };
  if (/^closed\b/.test(line)) return { kind: "closed" };
  return { kind: /^working\b/.test(line) ? "working" : "other" };
}
export function suppressed(line: string | undefined, now: Date): boolean {
  const status = parseStatus(line);
  return (status.kind === "waiting-on" || status.kind === "barred-by") && (status.until ?? 0) > now.getTime();
}
export const clean = (text: string): string => text.replace(/"/g, "'").replace(/\s+/g, " ").trim();
export function closedLine(to: string | undefined, reason: string | undefined, now: Date): string {
  return `closed${to ? ` reassigned-to ${to}` : ""} at ${now.toISOString()}${reason ? ` reason "${clean(reason)}"` : ""}`;
}
