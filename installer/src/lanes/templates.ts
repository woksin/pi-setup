import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanesCtx } from "./ctx.ts";
import { shellQuote } from "./terminal.ts";
import { expand, type Config } from "./config.ts";
export function renderTemplate(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (token, name) => Object.hasOwn(vars, name) ? String(vars[name]) : token);
}
export function readTemplate(ctx: LanesCtx, name: string): string {
  return readFileSync(join(ctx.templatesDir, name), "utf8");
}
export function templateVars(c: Config, ctx: LanesCtx, root: string): Record<string, string | number> {
  const messages = expand(c.messages.dir, c, root, ctx.home);
  return { root, root_sh: shellQuote(root), messages_sh: shellQuote(messages), coordinator_sh: shellQuote(c.coordinator.id),
    coordinator: c.coordinator.id, maxRunning: c.coordinator.maxRunning,
    rules: join(root, "rules.md"), messages,
    watches: join(root, "coordinator/WATCHES.md"), handoff: join(root, "coordinator/handoff-protocol.md") };
}
