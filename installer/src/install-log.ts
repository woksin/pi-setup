import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "./types.ts";

/** Everything the installer does not show on screen goes here, so the screen stays short. */
export const logPath = (ctx: Pick<Ctx, "home">): string => join(ctx.home, ".local/state/pi-setup/install.log");

export function appendLog(ctx: Pick<Ctx, "home">, text: string): void {
  try {
    mkdirSync(dirname(logPath(ctx)), { recursive: true });
    appendFileSync(logPath(ctx), text);
  } catch { /* logging must not stop an install */ }
}
