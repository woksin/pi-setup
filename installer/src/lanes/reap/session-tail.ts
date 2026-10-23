import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Read a bounded UTF-8 suffix, dropping only the incomplete first line. */
export function sessionTail(path: string, limit = 8 * 1024 * 1024): { text: string; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size; const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, start + bytes);
      if (!read) break;
      bytes += read;
    }
    const data = buffer.subarray(0, bytes);
    const offset = start ? data.indexOf(10) + 1 : 0;
    if (start && !offset) throw new Error("session tail has no complete line boundary");
    return { text: data.subarray(offset).toString("utf8"), truncated: start > 0 };
  } finally { closeSync(fd); }
}
