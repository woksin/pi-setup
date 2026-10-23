import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/home.ts";
import { FileBackend } from "../src/lanes/backend.ts";

test("file backend collision safety, recipient rules, filters and status", async () => {
  const dir = tempDir("lanes-messages");
  const b = new FileBackend(dir, () => new Date(2026, 0, 1, 12, 0));
  const first = await b.send({ from: "L0", to: "L1", topic: "hello", body: "hi" });
  const second = await b.send({ from: "L0", to: "L1", topic: "hello", body: "again" });
  assert.equal(readFileSync(first.path, "utf8"), "hi"); assert.match(second.name, /-2\.md$/);
  for (const to of ["ALL", "TEAM", "ALIAS", "L2"]) await b.send({ from: "L0", to, topic: "test", body: "x" });
  await b.send({ from: "L1", to: "ALL", topic: "self", body: "x" });
  await b.send({ from: "ALIAS", to: "L1", topic: "self", body: "x" });
  writeFileSync(join(dir, "ALL-notice.md"), "broadcast");
  writeFileSync(join(dir, "TEAM-notice.md"), "group");
  const inbox = await b.inbox("L1", { groups: ["TEAM"], aliases: ["ALIAS"] });
  assert.equal(inbox.length, 7); assert.ok(inbox.every((m) => !["L1", "ALIAS"].includes(m.from)));
  assert.equal((await b.list({ to: "L2" })).length, 1);
  assert.equal((await b.list({ from: "L0", limit: 2 })).length, 2);
  mkdirSync(join(dir, "status")); writeFileSync(join(dir, "status/L1.status"), "working since now\nignored\n");
  assert.equal(await b.status("L1"), "working since now"); assert.equal(await b.status("L2"), undefined);
  await assert.rejects(() => b.send({ from: "../x", to: "L1", topic: "x", body: "x" }));
});
