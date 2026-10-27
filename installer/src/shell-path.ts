import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { timestamp } from "./fsx.ts";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { Ctx } from "./types.ts";

export function missingBinDirs(ctx: Ctx): string[] {
  // The bootstrap may have prepended directories for this run only; the user's own shell does not have them.
  const paths = (ctx.env.PI_SETUP_USER_PATH ?? ctx.env.PATH ?? "").split(delimiter).map(p => resolve(ctx.cwd, p));
  return [".local/bin", ".pi/agent/bin"].filter(p => !paths.includes(join(ctx.home, p)));
}

export function shellPath(ctx: Ctx): { file: string; snippet: string } {
  const shell = basename(ctx.env.SHELL ?? "sh");
  if (shell === "fish") return { file: join(ctx.home, ".config/fish/config.fish"), snippet: 'fish_add_path "$HOME/.local/bin" "$HOME/.pi/agent/bin"' };
  const rc = shell === "zsh" ? ".zshrc" : shell === "bash" ? (ctx.platform === "darwin" ? ".bash_profile" : ".bashrc") : ".profile";
  return { file: join(ctx.home, rc), snippet: 'export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"' };
}

/** In the interactive Review the PATH edit is pre-ticked; confirming Install is the opt-in. Flip this to make it opt-in. */
export const PATH_EDIT_DEFAULT = true;

/** The Review line for the PATH edit, or undefined when both directories are already on PATH. */
export function pathEditLine(ctx: Ctx): string | undefined {
  if (!missingBinDirs(ctx).length) return undefined;
  return `Add ~/.local/bin and ~/.pi/agent/bin to PATH in ${shellPath(ctx).file.replace(ctx.home, "~")}`;
}

const tilde = (ctx: Ctx, path: string): string => path.replace(ctx.home, "~");

/** The one command that puts the tools on PATH for this user's shell; printed wherever PATH is missing. */
export function pathFixCommand(ctx: Ctx): string {
  const { file, snippet } = shellPath(ctx);
  return `echo '${snippet}' >> ${tilde(ctx, file)}`;
}

/** Shell startup files are user-owned: append only on explicit opt-in, never replace them. */
export function configureShellPath(ctx: Ctx, edit: boolean, dryRun: boolean, guided = false): void {
  if (!missingBinDirs(ctx).length) return;
  const { file, snippet } = shellPath(ctx);
  if (guided && !edit) return;
  if (!edit) {
    // A real run leaves the how-to to the finish screen's numbered steps; plan and dry-run show it here.
    if (!guided && dryRun) ctx.out(`PATH: not set up. To fix it: ${pathFixCommand(ctx)}`);
    return;
  }
  if (dryRun) { ctx.out(`would append PATH snippet to ${tilde(ctx, file)} (the file is backed up first)`); return; }
  let text = "";
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (text.split("\n").includes(snippet)) return;
  mkdirSync(dirname(file), { recursive: true });
  const backup = text ? `${file}.pi-setup-bak-${timestamp(ctx.now())}` : undefined;
  if (backup) copyFileSync(file, backup);
  appendFileSync(file, `\n# pi-setup tools\n${snippet}\n`);
  if (!guided) ctx.out(`✓ Added ~/.local/bin and ~/.pi/agent/bin to PATH in ${tilde(ctx, file)}${backup ? ` (backup: ${tilde(ctx, backup)})` : ""}`);
}
