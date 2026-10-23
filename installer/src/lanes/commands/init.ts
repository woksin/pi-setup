import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaults, loadConfig, validate } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { readTemplate, renderTemplate, templateVars } from "../templates.ts";
export async function init(args: string[], opts: Record<string, string>, ctx: LanesCtx): Promise<number> {
  const root = resolve(ctx.cwd, args[0] || ".");
  const configPath = join(root, "lanes.json");
  const c = existsSync(configPath) ? loadConfig(root) : defaults(root, ctx.home, opts["repos-root"]);
  if (!existsSync(configPath)) {
    c.coordinator.id = opts.coordinator || c.coordinator.id;
    c.terminal.backend = opts.terminal || c.terminal.backend;
    c.launch.preapproveMcp = opts["preapprove-mcp"] === "true";
  }
  validate(c);
  const vars = templateVars(c, ctx, root);
  const put = (rel: string, content: string) => {
    const path = join(root, rel); mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) ctx.out(`kept ${path}`);
    else { writeFileSync(path, content, { flag: "wx" }); ctx.out(`created ${path}`); }
  };
  put("lanes.json", `${JSON.stringify(c, null, 2)}\n`);
  for (const [source, dest] of [["rules.md", "rules.md"], ["coordinator.md", "prompts/coordinator.md"], ...["WATCHES.md", "handoff-protocol.md", "NOW.md", "STATE.md"].map((n) => [n, `coordinator/${n}`])]) {
    put(dest, renderTemplate(readTemplate(ctx, source), vars));
  }
  const status = join(root, "messages/status"); const hadStatus = existsSync(status); mkdirSync(status, { recursive: true }); ctx.out(`${hadStatus ? "kept" : "created"} ${status}`);
  const ignore = join(root, ".gitignore"); const text = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const missing = [".state/", "messages/"].filter((s) => !text.split(/\r?\n/).includes(s));
  if (missing.length) { writeFileSync(ignore, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`); ctx.out(`created ${ignore}`); }
  else ctx.out(`kept ${ignore}`);
  return 0;
}
