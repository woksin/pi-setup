import { join, resolve } from "node:path";

// Keep legacy uppercase hyphenated ids for message-file compatibility.
const ID = "(?:[A-Z][A-Z0-9]*[a-z]?|[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)+)";
export const validId = (s: string): boolean => s.length <= 32 && /^(?:[A-Z][A-Z0-9]*[a-z]?|R-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)$/.test(s);
export const validTopic = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "") || "task";
export function messageName(from: string, to: string, topic: string, at: Date, collision = 1): string {
  const hhmm = `${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`;
  return `${from}-to-${to}-${topic}-${hhmm}${collision > 1 ? `-${collision}` : ""}.md`;
}

export function parseMessageName(name: string): { from: string; to: string[]; topic: string } | undefined {
  const hasTimestamp = /^\d{8}-\d{6}-/.test(name);
  name = name.replace(/^\d{8}-\d{6}-/, "");
  const timestamped = new RegExp(`^(${ID})-to-(${ID})-([a-z0-9][a-z0-9-]*)\\.md$`).exec(name);
  const match = new RegExp(`^(${ID})-to-(${ID})-([a-z0-9][a-z0-9-]*?)-[0-9]{4}(?:-[0-9]+)?\\.md$`).exec(name);
  if (match) return { from: match[1], to: [match[2]], topic: match[3] };
  if (timestamped && directedName(timestamped, hasTimestamp)) {
    return { from: timestamped[1], to: [timestamped[2]], topic: timestamped[3] };
  }
  const legacy = new RegExp(`^(${ID})-from-(${ID})-([a-z0-9].*)\\.md$`).exec(name);
  if (legacy) return { from: legacy[2], to: [legacy[1]], topic: legacy[3] };
  // Broadcast/group files also use the recipient-prefix convention.
  const prefix = new RegExp(`^(${ID})-([a-z0-9].*)\\.md$`).exec(name);
  if (prefix) return { from: "", to: [prefix[1]], topic: prefix[2] };
  return undefined;
}

function directedName(match: RegExpExecArray, hasTimestamp: boolean): boolean {
  return hasTimestamp || suffixedId(match[1]) || suffixedId(match[2]);
}
function suffixedId(id: string): boolean { return /[a-z]$/.test(id); }

export function sessionDirFor(cwd: string, piAgentDir: string): string {
  return join(piAgentDir, "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}
