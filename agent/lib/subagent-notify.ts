/**
 * subagent-notify — expand truncated pi-subagents completion previews (500 chars
 * single, 300 grouped) from the full result held by the manager registry, so a
 * compliant report arrives whole and needs no get_subagent_result round trip.
 * Pure: no pi imports; never throws.
 */
export const NOTIFY_PREVIEW = 1800;
export const TRUNCATION_MARKER = "\n...(truncated, use get_subagent_result for full output)";

export interface NotifyRecord { status?: string; result?: string }
export type NotifyLookup = (id: string) => NotifyRecord | undefined;

// Mirrors pi-subagents src/xml.ts escapeXml (& < > only).
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Expand truncated `<result>` previews whose registry record is finished and extends the preview. */
export function expandNotification(content: string, lookup: NotifyLookup, limit = NOTIFY_PREVIEW): string {
  try {
    return content.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, block => {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(block)?.[1];
      const body = /<result>([\s\S]*?)<\/result>/.exec(block);
      if (!id || !body) return block;
      const decoded = unescapeXml(body[1]);
      if (!decoded.endsWith(TRUNCATION_MARKER)) return block;
      const prefix = decoded.slice(0, -TRUNCATION_MARKER.length);
      const record = lookup(unescapeXml(id));
      if (!record || record.status === "running" || record.status === "queued") return block;
      if (typeof record.result !== "string" || !record.result.startsWith(prefix)) return block;
      if (limit <= prefix.length) return block;
      const next = record.result.slice(0, limit) + (record.result.length > limit ? TRUNCATION_MARKER : "");
      return block.replace(body[0], () => `<result>${escapeXml(next)}</result>`);
    });
  } catch {
    return content;
  }
}

const REPORT_LIMITS: Record<string, number> = { ops: 1500, reviewer: 1500 };
const DEFAULT_REPORT_LIMIT = 2500;

/** The report is over the size its agent type is briefed to stay within (chars of the full registry result). */
export function oversizedReport(result: string, agentType: string | undefined): { chars: number; limit: number } | undefined {
  const limit = (agentType && REPORT_LIMITS[agentType]) || DEFAULT_REPORT_LIMIT;
  return result.length > limit ? { chars: result.length, limit } : undefined;
}
