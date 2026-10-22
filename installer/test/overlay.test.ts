import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { hasRoutingMarkers, overlayFor, spliceRouting } from "../src/profiles.ts";
import type { Settings } from "../src/types.ts";
import { tempDir } from "./helpers/home.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("the overlay uses pi-profile's filter: *.md under agents/ and *.js under workflows/, top level only", () => {
  const repo = tempDir("pisetup-overlay");
  dirs.push(repo);
  const base = join(repo, "agent/profiles/x");
  for (const f of ["agents/a.md", "agents/b.txt", "agents/c.md.bak-1", "agents/sub/d.md", "workflows/w.js", "workflows/w.md", "workflows/w.js.bak-1"]) {
    mkdirSync(join(base, f, ".."), { recursive: true });
    writeFileSync(join(base, f), "x");
  }
  const overlay = overlayFor(repo, "x", {} as Settings);
  assert.deepEqual([...overlay.sources.keys()].sort(), ["agents/a.md", "workflows/w.js"]);
});

const START_LINE = "<!-- pi-profile:routing:start (managed by pi-profile) -->\n";
const END_LINE = "<!-- pi-profile:routing:end -->";

test("spliceRouting keeps the live marker lines exactly and replaces only the body", () => {
  const base = Buffer.from(`head\n${START_LINE}old\n${END_LINE}\ntail\n`);
  const live = Buffer.from(`other head\n<!-- pi-profile:routing:start (mine) -->\nlive body\n${END_LINE} !\nother tail\n`);
  const out = spliceRouting(base, Buffer.from("NEW\n"), live).toString();
  assert.equal(out, `head\n<!-- pi-profile:routing:start (mine) -->\nNEW\n${END_LINE} !\ntail\n`);
  assert.equal(spliceRouting(base, Buffer.from("NEW\n")).toString(), `head\n${START_LINE}NEW\n${END_LINE}\ntail\n`);
});

test("marker detection", () => {
  assert.equal(hasRoutingMarkers(Buffer.from(`${START_LINE}x\n${END_LINE}`)), true);
  assert.equal(hasRoutingMarkers(Buffer.from("no markers")), false);
  assert.equal(hasRoutingMarkers(Buffer.from(`${END_LINE}\n${START_LINE}`)), false);
});
