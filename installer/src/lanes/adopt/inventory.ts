import { readFileSync } from "node:fs";

export interface InventoryEntry { tty: string; worktree: string; id: string }
export function inventory(path?: string): InventoryEntry[] {
  if (!path) return [];
  const rows = readFileSync(path, "utf8").split("\n").filter(l => l.trim().startsWith("|"));
  const cells = (line: string) => line.split("|").slice(1, -1).map(s => s.trim().replace(/^`|`$/g, ""));
  const header = rows.findIndex(l => {
    const c = cells(l); return c.includes("tty") && c.includes("worktree") && c.includes("lane");
  });
  if (header < 0) throw new Error("inventory must have tty / worktree / lane columns");
  const keys = cells(rows[header]);
  return rows.slice(header + 1).map(line => entry(cells(line), keys)).filter((e): e is InventoryEntry => e !== undefined);
}
function entry(c: string[], keys: string[]): InventoryEntry | undefined {
  const tty = c[keys.indexOf("tty")];
  if (!/^(?:ttys)?\d+$/.test(tty)) return undefined;
  return { tty: tty.startsWith("ttys") ? tty : `ttys${tty.padStart(3, "0")}`, worktree: c[keys.indexOf("worktree")], id: c[keys.indexOf("lane")] };
}
