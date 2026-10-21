/**
 * subagent-result-guard — avoid paying twice for a delivered subagent result.
 * A complete notification is the result; a truncated preview permits one fetch.
 * Explicit verbose conversation requests remain allowed. Raw task transcripts
 * must not be read through bash. Disable via /guards off subagent-results.
 * State follows delivered custom messages, not the earlier completion event.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isGuardOff } from "../lib/guards.ts";
import { argsOf, executableCommands } from "./wait-guard.ts";

const FETCH_HELP = "subagent-results: completion notification already delivered. Use that result; do not fetch it again. " +
  "A truncated preview permits only the first fetch. Use verbose: true only when you need the full conversation.";
const OUTPUT_HELP = "subagent-results: raw task transcript reads through bash are blocked. Use the completion notification, " +
  "or get_subagent_result once if its preview was truncated; use verbose: true when the full conversation is needed.";
const TRUNCATION = "...(truncated, use get_subagent_result for full output)";
const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export class ResultTracker {
  private delivered = new Map<string, { truncated: boolean; fetched: boolean }>();
  private aliases = new Map<string, string>();
  private observed = new Set<string>();

  clear(): void { this.delivered.clear(); this.aliases.clear(); this.observed.clear(); }
  alias(id: string, name: unknown): void {
    if (typeof name === "string" && name) this.aliases.set(name.replace(/^@/, ""), id);
  }
  restarted(ref: string): void {
    this.delivered.delete(this.aliases.get(ref) ?? ref);
  }
  /** Only called for messages actually entering this session's conversation. */
  notification(message: unknown): void {
    const msg = message as { role?: string; customType?: string; content?: unknown; timestamp?: number } | undefined;
    if (msg?.role !== "custom" || msg.customType !== "subagent-notification") return;
    const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content)
      ? msg.content.map(part => part?.type === "text" ? part.text : "").join("\n") : "";
    const delivery = `${msg.timestamp ?? ""}\0${content}`;
    if (this.observed.has(delivery)) return;
    this.observed.add(delivery);
    for (const match of content.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(match[1])?.[1];
      const result = /<result>([\s\S]*?)<\/result>/.exec(match[1])?.[1];
      if (!id || result === undefined) continue;
      const key = decode(id);
      // message_end and before_agent_start may observe the same notification.
      if (!this.delivered.has(key)) this.delivered.set(key, { truncated: decode(result).endsWith(TRUNCATION), fetched: false });
      // The documented pi-subagents manager registry exposes records by id.
      // Read identity only: no npm import, mutation, result read or consumption.
      const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] as
        { getRecord?: (id: string) => { handle?: string; alias?: string } | undefined } | undefined;
      const record = registry?.getRecord?.(key);
      this.alias(key, record?.handle);
      this.alias(key, record?.alias);
    }
  }
  /** Reserve the one fetch at tool_call time, so parallel calls cannot both take it. */
  fetch(ref: string, verbose: boolean): string | undefined {
    const key = ref.replace(/^@/, "");
    const state = this.delivered.get(this.aliases.get(key) ?? key);
    if (!state) return undefined;
    if (!verbose && (!state.truncated || state.fetched)) return FETCH_HELP;
    state.fetched = true;
    return undefined;
  }
}

/** Mirrors pi-subagents' tmpdir()/pi-subagents-<uid>/<cwd>/<session>/tasks layout. */
export function isTaskOutput(path: string, cwd: string): boolean {
  const roots = [resolve(tmpdir())];
  try { roots.push(realpathSync(tmpdir())); } catch { /* lexical root still works */ }
  const normalized = resolve(cwd, path.replace(/^</, ""));
  return roots.some(root => {
    const relative = normalized.startsWith(root + sep) ? normalized.slice(root.length + 1).split(sep).join("/") : "";
    return /^pi-subagents-[^/]+\/.+\/tasks\/[^/]+\.output$/.test(relative);
  });
}

export function readsTaskOutput(command: string, cwd: string): boolean {
  return executableCommands(command).some(words => ["cat", "head", "tail", "less"].some(program => {
    const args = argsOf(words, program);
    return args?.some(arg => isTaskOutput(arg, cwd)) === true;
  }));
}

export default function (pi: ExtensionAPI) {
  const tracker = new ResultTracker();
  let unsubscribe: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    tracker.clear();
    unsubscribe?.();
    unsubscribe = pi.events.on("subagents:started", data => {
      const id = (data as { id?: string })?.id;
      if (id) tracker.restarted(id);
    });
    // Restore notifications and fetch reservations after /reload, on the active branch only.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom_message") tracker.notification({ ...entry, role: "custom" });
      if (entry.type !== "message") continue;
      tracker.notification(entry.message);
      const msg = entry.message;
      if (msg.role === "toolResult") for (const call of msg.nestedCalls?.calls ?? []) {
        const input = call.arguments as { agent_id?: string; verbose?: boolean } | undefined;
        if (call.name === "get_subagent_result" && input?.agent_id) tracker.fetch(input.agent_id, input.verbose === true);
      }
      if (msg.role === "assistant") for (const part of msg.content) {
        if (part.type !== "toolCall") continue;
        const input = part.arguments as { agent_id?: string; verbose?: boolean; resume?: string };
        if (part.name === "get_subagent_result" && input.agent_id) tracker.fetch(input.agent_id, input.verbose === true);
        if (part.name === "Agent" && input.resume) tracker.restarted(input.resume);
      }
    }
  });
  pi.on("session_shutdown", () => { unsubscribe?.(); unsubscribe = undefined; });
  pi.on("message_end", event => { tracker.notification(event.message); });
  // Context-only custom messages can bypass extension message_end (e.g. sendMessage
  // without triggerTurn). Observe them at the actual model-delivery boundary too.
  pi.on("context", event => {
    for (const message of event.messages) tracker.notification(message);
  });
  pi.on("before_agent_start", event => {
    if (event.messageType === "custom") tracker.notification({ ...event.message, role: "custom" });
  });
  pi.on("tool_result", event => {
    if (event.toolName !== "Agent" || event.isError) return;
    const details = event.details as { id?: string } | undefined;
    const id = details?.id;
    if (id) tracker.alias(id, event.input.name);
  });
  pi.on("tool_call", (event, ctx) => {
    const input = event.input as { agent_id?: string; verbose?: boolean; command?: string; resume?: string };
    if (event.toolName === "Agent" && typeof input.resume === "string") tracker.restarted(input.resume);
    let reason: string | undefined;
    if (event.toolName === "get_subagent_result" && typeof input.agent_id === "string") {
      reason = tracker.fetch(input.agent_id, input.verbose === true);
    } else if (event.toolName === "bash" && typeof input.command === "string" && readsTaskOutput(input.command, ctx.cwd)) {
      reason = OUTPUT_HELP;
    }
    if (reason && !isGuardOff("subagent-results")) return { block: true, reason };
    return undefined;
  });
}
