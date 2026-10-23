import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "./helpers/home.ts";

const canonical = "- Builds/tests: always through `~/.pi/agent/bin/pi-phase run` with your brief's exact gate command; pi-phase decides direct/fast/queued. A `--policy` or other execution decision in your parent's brief is binding and overrides any general rule. High priority only when the brief grants it.";
const implementers = new Set(["implementer.md", "careful-implementer.md", "opus-implementer.md", "general-purpose.md"]);
const forbidden = /--priority|--queue-timeout|grant-priority|pi-phase run --kind/;

function agentDirectories(): string[] {
  const profiles = join(REPO, "agent/profiles");
  return [join(REPO, "agent/agents"), ...readdirSync(profiles, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join(profiles, entry.name, "agents"))];
}

test("agent execution policy has one canonical rule and no duplicated scheduler flags", () => {
  let checked = 0;
  for (const dir of agentDirectories()) {
    for (const name of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      const path = join(dir, name);
      const text = readFileSync(path, "utf8");
      assert.doesNotMatch(text, forbidden, path);
      assert.doesNotMatch(text, /never ask for.*priority|priority.*needs the user's approval/i, path);
      if (implementers.has(name)) {
        assert.equal(text.split(canonical).length - 1, 1, path);
        assert.equal(text.match(/pi-phase run/g)?.length, 1, path);
        checked++;
      }
    }
  }
  assert.equal(checked, 32);
  const shared = readFileSync(join(REPO, "agent/AGENTS.subagent.md"), "utf8");
  assert.doesNotMatch(shared, forbidden);
  assert.equal(shared.split("## Execution budgets and verification\n\n")[1].split("\n\n## ")[0], canonical);
});
