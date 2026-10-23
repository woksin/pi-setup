interface ProcessRow { pid: number; ppid: number; pgid: number; command: string }

function processTable(text: string): ProcessRow[] | undefined {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n").filter(l => l.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) return undefined;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] });
  }
  if (new Set(rows.map(row => row.pid)).size !== rows.length) return undefined;
  return rows;
}
function ancestors(pid: number, table: Map<number, ProcessRow>): Set<number> {
  const family = new Set<number>();
  let current = table.get(pid);
  while (current && !family.has(current.pid)) {
    family.add(current.pid); current = table.get(current.ppid);
  }
  return family;
}
/** A wrapper and pi's descendants may share its foreground group, but siblings may not. */
export function expectedForeground(pid: number, pgid: number, text: string): boolean {
  const rows = processTable(text); if (!rows) return false;
  const table = new Map(rows.map(row => [row.pid, row]));
  const pi = table.get(pid);
  if (pi?.pgid !== pgid) return false;
  if (!/^(?:\S*\/)?pi(?:\s|$)/.test(pi.command)) return false;
  const parents = ancestors(pid, table);
  return rows.filter(row => row.pgid === pgid).every(row =>
    parents.has(row.pid) || ancestors(row.pid, table).has(pid));
}
