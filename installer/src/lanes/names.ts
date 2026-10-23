import { join, resolve } from "node:path";

// Keep legacy uppercase hyphenated ids for message-file compatibility.
const ID = "(?:[A-Z][A-Z0-9]*[a-z]?|[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)+)";
export const validNewId = (s: string): boolean => s.length <= 32 && /^(?:[A-Z][A-Z0-9]*[a-z]?|R-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)$/.test(s);
export const validId = (s: string): boolean => s.length <= 32 && new RegExp(`^${ID}$`).test(s);
export const validTopic = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,47}$/.test(s);
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32).replace(/-$/, "") || "task";
export function messageName(from: string, to: string, topic: string, at: Date, collision = 1): string {
  const hhmm = `${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`;
  return `${from}-to-${to}-${topic}-${hhmm}${collision > 1 ? `-${collision}` : ""}.md`;
}

export function parseMessageName(name: string): { from: string; to: string[]; topic: string } | undefined {
  if (!name.endsWith(".md")) return undefined;
  const tokens = name.replace(/^(?:\d+-)+/, "").slice(0, -3).split("-");
  const k = tokens.findIndex(t => t === "to" || t === "from");
  const start = k < 0 ? 0 : k + 1;
  let end = start;
  while (end < tokens.length && messageIdToken(tokens[end])) end++;
  const topic = tokens.slice(end).join("-").replace(/-[0-9]{4}(?:-[0-9]+)?$/, "");
  if (end === start || !topic) return undefined;
  if (k < 0) return { from: "", to: [tokens.slice(0, end).join("-")], topic };
  const left = tokens.slice(0, k);
  if (!left.length || !left.every(messageIdToken)) return undefined;
  const right = tokens.slice(start, end).join("-");
  return tokens[k] === "to" ? { from: left.join("-"), to: [right], topic }
    : { from: right, to: [left.join("-")], topic };
}

// inbox-watch's ids are a run of capital-start tokens (or legacy ttys ids).
function messageIdToken(token: string): boolean { return /^[A-Z]/.test(token) || /^ttys[0-9]+$/.test(token); }
export function messageTokenMatch(name: string, id: string): boolean {
  return (`-${name.replace(/\.md$/, "")}-`).includes(`-${id}-`);
}

export function sessionDirFor(cwd: string, piAgentDir: string): string {
  return join(piAgentDir, "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}
