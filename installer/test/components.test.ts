import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgs } from "../src/args.ts";
import { available, detectDefaults, dropExtensions, dropGuardExtension, resolveComponents, stripSections } from "../src/components.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pisetup-comp."));
  roots.push(d);
  return d;
};
const none = { "docker-guardian": false, cleanup: false, "secret-sweep": false, "disk-growth": false, codescene: false, cratis: false, web: false, lanes: false };

test("precedence: flag > answer > saved > installed > detected", () => {
  const r = resolveComponents({
    flags: { cratis: false }, answers: { cratis: true, web: false }, saved: { web: { on: true }, codescene: { on: false } },
    current: { codescene: true, cratis: true }, detected: { ...none, web: true, codescene: true }, interactive: true,
  });
  assert.deepEqual(r.cratis, { on: false, source: "flag" });
  assert.deepEqual(r.web, { on: false, source: "prompt" });
  assert.deepEqual(r.codescene, { on: false, source: "saved" });
  const i = resolveComponents({ current: { cratis: true }, detected: none, interactive: false });
  assert.deepEqual(i.cratis, { on: true, source: "installed" });
});

test("services are off without a flag or saved choice when not interactive, detected when interactive", () => {
  const detected = { ...none, "docker-guardian": true, cleanup: true };
  assert.deepEqual(resolveComponents({ detected, interactive: false })["docker-guardian"], { on: false, source: "default" });
  assert.deepEqual(resolveComponents({ detected, interactive: true })["docker-guardian"], { on: true, source: "detected" });
  assert.equal(resolveComponents({ detected, interactive: false, flags: { cleanup: true } }).cleanup.on, true);
});

test("availability: docker-guardian and secret-sweep need macOS; cleanup also works with systemd", () => {
  const which = (n: string) => (n === "systemctl" ? "/bin/systemctl" : undefined);
  assert.equal(available("docker-guardian", { platform: "linux", which }), "needs Docker Desktop on macOS");
  assert.equal(available("docker-guardian", { platform: "darwin", which }), true);
  assert.equal(typeof available("disk-growth", { platform: "linux", which }), "string");
  assert.equal(available("disk-growth", { platform: "darwin", which }), true);
  assert.equal(available("cleanup", { platform: "linux", which }), true);
  assert.equal(typeof available("cleanup", { platform: "linux", which: () => undefined }), "string");
});

test("detectDefaults: Cratis by org, directory or a .cratis dir; CodeScene by presence of cs-mcp or the token; web always", () => {
  const root = tmp();
  const ctx = (env: Record<string, string> = {}, tools: string[] = []) => ({ platform: "darwin", env, which: (n: string) => (tools.includes(n) ? `/x/${n}` : undefined) });
  const gh = (orgs: string[]) => ({ github: { orgs } as never });
  assert.equal(detectDefaults(ctx(), gh([]), root).cratis, false);
  assert.equal(detectDefaults(ctx(), gh(["CRATIS"]), root).cratis, true);
  mkdirSync(join(root, "app/.cratis"), { recursive: true });
  assert.equal(detectDefaults(ctx(), gh([]), root).cratis, true);
  const other = tmp();
  mkdirSync(join(other, "Cratis"));
  assert.equal(detectDefaults(ctx(), gh([]), other).cratis, true);
  assert.equal(detectDefaults(ctx(), gh([]), root).codescene, false);
  assert.equal(detectDefaults(ctx({ CS_ACCESS_TOKEN: "x" }), gh([]), root).codescene, true);
  assert.equal(detectDefaults(ctx({}, ["cs-mcp", "docker", "gitleaks"]), gh([]), root)["secret-sweep"], true);
  assert.equal(detectDefaults(ctx({}, ["docker"]), gh([]), root)["docker-guardian"], true);
  assert.equal(detectDefaults(ctx(), gh([]), root).web, true);
  assert.equal(detectDefaults(ctx(), gh([]), root)["disk-growth"], true);
  assert.equal(detectDefaults({ ...ctx(), platform: "linux" }, gh([]), root)["disk-growth"], false);
});

test("stripSections removes a marked block with one blank line and warns when markers are missing", () => {
  const text = "a\n\n<!-- pi-setup:cratis:start (x) -->\n## C\nbody\n<!-- pi-setup:cratis:end -->\n\nb\n";
  const out = stripSections(Buffer.from(text), ["cratis", "codescene"]);
  assert.equal(out.content.toString(), "a\n\nb\n");
  assert.deepEqual(out.warnings, ["AGENTS.md has no pi-setup:codescene markers; its codescene section stays"]);
});

test("dropGuardExtension edits only the frontmatter list", () => {
  const md = "---\nname: x\nextensions: [cratis-cli-guard, provider-fallback]\n---\nextensions: [cratis-cli-guard]\n";
  assert.equal(dropGuardExtension(Buffer.from(md)).toString(), "---\nname: x\nextensions: [provider-fallback]\n---\nextensions: [cratis-cli-guard]\n");
});

test("dropExtensions drops several names and leaves the rest", () => {
  const md = "---\nname: x\nextensions: [a, pi-mcp-adapter, pi-browser-use]\n---\n";
  assert.equal(dropExtensions(Buffer.from(md), ["pi-browser-use"]).toString(), "---\nname: x\nextensions: [a, pi-mcp-adapter]\n---\n");
});

test("--with and --without parse for install, validate ids and reject both at once", () => {
  const ok = parseArgs(["--with", "cratis", "--without", "web", "--with", "cleanup"], "/w");
  assert.ok(ok.ok);
  assert.deepEqual([ok.options.with, ok.options.without], [["cratis", "cleanup"], ["web"]]);
  const bad = parseArgs(["--with", "nope"], "/w");
  assert.ok(!bad.ok && bad.error.includes("docker-guardian"));
  assert.ok(!parseArgs(["--with", "web", "--without", "web"], "/w").ok);
  assert.ok(!parseArgs(["uninstall", "--with", "web"], "/w").ok);
});
