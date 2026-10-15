import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Default Anthropic prompt caching to the 1-hour tier for every pi process, including
// ones started from shells that never sourced PI_CACHE_RETENTION=long.
// Usage history (2026-09) showed main sessions re-writing their whole context after
// 5–60 minute pauses (waiting on subagents/CI/the user) because most processes ran
// with the 5-minute tier. An explicit PI_CACHE_RETENTION (short/none) still wins.
export default function (_pi: ExtensionAPI) {
  if (!process.env.PI_CACHE_RETENTION) process.env.PI_CACHE_RETENTION = "long";
}
