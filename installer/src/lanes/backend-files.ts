import { parseMessageName } from "./names.ts";

/** Paths relative to messages.dir reserved by the file backend and retention. */
export function backendOwnedName(name: string): boolean {
  if (parseMessageName(name)) return true;
  if (name.endsWith("-inbox.marker")) return true;
  return /^(?:status|archive)(?:\/|$)/.test(name);
}
