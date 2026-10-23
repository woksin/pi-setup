import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertTempHome, tempDir } from "./helpers/home.ts";
import type { LanesCtx } from "../src/lanes/ctx.ts";
import { preapprove } from "../src/lanes/preapprove.ts";

test("MCP preapproval is optional, guarded, non-blocking and uses the adapter API", async () => {
  const home = tempDir("lanes-mcp"); const cwd = join(home, "wt"); mkdirSync(cwd);
  const errors: string[] = []; const lines: string[] = [];
  const ctx = { piAgentDir: join(home, "agent"), err: (s: string) => errors.push(s), out: (s: string) => lines.push(s), loadModule: async () => ({}) } as LanesCtx;
  await preapprove(ctx, cwd, true); assert.equal(errors.length, 0);
  writeFileSync(join(cwd, ".mcp.json"), '{"mcpServers":{"hello":{"command":"test"}}}');
  await preapprove(ctx, cwd, false); assert.equal(errors.length, 0); assert.match(lines.pop()!, /preapproval is off.*--preapprove-mcp/);
  await preapprove(ctx, cwd, true); assert.match(errors.pop()!, /adapter not found/);
  const adapter = join(ctx.piAgentDir, "npm/node_modules/pi-mcp-adapter"); mkdirSync(adapter, { recursive: true });
  writeFileSync(join(adapter, "package.json"), '{"version":"6.0.0"}');
  await preapprove(ctx, cwd, true); assert.match(errors.pop()!, /adapter 6.0.0 not supported \(supports 5.x\)/);
  writeFileSync(join(adapter, "package.json"), '{"version":"5.1.0"}');
  await preapprove(ctx, cwd, true); assert.match(errors.pop()!, /adapter API changed/);
  ctx.loadModule = async (path) => {
    assert.equal(path, join(adapter, "dist/project-server-trust.js"));
    return { hashProjectServerDefinition: () => "abcdef1234567890", approveProjectServer: (...args: unknown[]) => writeFileSync(join(home, "calls.json"), JSON.stringify(args)) };
  };
  await preapprove(ctx, cwd, true); assert.deepEqual(JSON.parse(readFileSync(join(home, "calls.json"), "utf8")), [cwd, "hello", { command: "test" }]);
  assert.deepEqual(lines, ["approved .mcp.json hello abcdef123456"]);
  writeFileSync(join(cwd, ".mcp.json"), "{"); await preapprove(ctx, cwd, true);
  assert.equal(errors.length, 1); assert.match(errors[0], /^MCP preapproval skipped: .*; pi will ask once per server when the lane starts\.$/);
});

test("a malformed project file is named accurately and does not prevent other file approvals", async () => {
  const home = assertTempHome(tempDir("lanes-mcp-invalid")); const cwd = join(home, "wt"); mkdirSync(join(cwd, ".pi"), { recursive: true });
  const bad = join(cwd, ".pi/mcp.json"); writeFileSync(bad, "{");
  writeFileSync(join(cwd, ".mcp.json"), '{"mcpServers":{"valid":{"command":"test"}}}');
  const adapter = join(home, "agent/npm/node_modules/pi-mcp-adapter"); mkdirSync(adapter, { recursive: true }); writeFileSync(join(adapter, "package.json"), '{"version":"5.1.0"}');
  const errors: string[] = []; const calls: unknown[][] = [];
  const ctx = { piAgentDir: join(home, "agent"), out: () => {}, err: (s: string) => errors.push(s), loadModule: async () => ({ hashProjectServerDefinition: () => "abcdef", approveProjectServer: (...args: unknown[]) => calls.push(args) }) } as LanesCtx;
  await preapprove(ctx, cwd, true);
  assert.deepEqual(errors, [`MCP preapproval skipped: invalid .pi/mcp.json (${bad}); pi will ask once per server when the lane starts.`]);
  assert.deepEqual(calls, [[cwd, "valid", { command: "test" }]]);
});
