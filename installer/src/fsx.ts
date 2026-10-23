import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync,
  realpathSync, renameSync, statSync, utimesSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYYmmdd-HHMMSS in local time, the stamp install.sh used for `.bak-<ts>`. */
export function timestamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Local build and OS clutter that must never be installed from a checkout. */
const isClutterFile = (name: string) => name.endsWith(".pi-setup-new") || name.endsWith(".pyc") || name === ".DS_Store";
const isClutterDir = (name: string) => name === "__pycache__" || name === "node_modules";

/** Relative paths of regular files below dir, without following symlinks (like `find -type f`), skipping local clutter. */
export function listFiles(dir: string, base = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      if (!isClutterFile(entry.name)) out.push(rel);
    }
    else if (entry.isDirectory() && !isClutterDir(entry.name)) out.push(...listFiles(dir, rel));
  }
  return out.sort();
}

/** Copy preserving mode and mtime (cp -p). */
export function backupCopy(from: string, to: string): void {
  copyFileSync(from, to);
  const st = statSync(from);
  chmodSync(to, st.mode & 0o7777);
  utimesSync(to, st.atime, st.mtime);
}

/** Write through a temporary file in the same directory, then rename. */
export function atomicWrite(link: string, data: Buffer | string, mode: number, pid = process.pid): void {
  // Write through a symlink so the link survives the rename.
  const path = existsSync(link) ? realpathSync(link) : link;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${pid}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
