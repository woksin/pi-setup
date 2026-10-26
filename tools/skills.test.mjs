// Source checks for the shipped skills: real pi frontmatter parsing and discovery, reviewed description
// snapshots, routing-fixture shape, and the review workflow's cache boundary that the sol-loop skill documents.
// Nothing here calls a model or proves LLM routing quality. Run: node --test tools/skills.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(REPO, "skills");

// Same lookup order as agent/bin/pi-setup-tests. A missing package is a setup failure, never a skip.
function findPiModules() {
  const candidates = [join(REPO, "agent/npm/node_modules"), join(REPO, "agent/node_modules"), join(homedir(), ".pi/agent/npm/node_modules")];
  const found = candidates.find((c) => existsSync(join(c, "@earendil-works/pi-coding-agent")));
  if (!found) throw new Error(`skills.test: @earendil-works/pi-coding-agent not found under ${candidates.join(", ")}; install pi, this test does not install it.`);
  return found;
}
const pi = await import(pathToFileURL(join(findPiModules(), "@earendil-works/pi-coding-agent/dist/index.js")).href);
const { parseFrontmatter, loadSkillsFromDir } = pi;

// Reviewed trigger hints. A regression guard against restoring summary prefixes, not semantic certification.
const EXPECTED = {
  "sol-loop": 'Use when the user says "sol loop".',
  "ai-work-lifecycle": "Use before creating disposable task outputs, running verification that leaves local artifacts, or closing a task with temporary artifacts.",
  "dev-machine-performance": "Use when local gates or phase queues are slow, the machine is swapping, or Docker shows memory pressure. Not for application-runtime performance tuning.",
  "github-issue-hygiene": "Use when starting work on, creating, commenting on, updating the description of, or finishing work on a GitHub issue, and during post-work cleanup to close completed, duplicate or obsolete issues.",
};

const skillDirs = () => readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const readSkill = (name) => parseFrontmatter(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8"));

test("the owned skill set is exactly the reviewed snapshots", () => {
  assert.deepEqual(skillDirs(), Object.keys(EXPECTED).sort());
});

test("every repository skill parses, matches its directory and is discovered", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: SKILLS, source: "test" });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(skills.map((s) => s.name).sort(), skillDirs());
  for (const name of skillDirs()) {
    const { frontmatter, body } = readSkill(name);
    assert.equal(frontmatter.name, name);
    assert.equal(typeof frontmatter.description, "string");
    assert.ok(frontmatter.description.trim().length > 0 && frontmatter.description.length <= 1024, `${name} description length`);
    assert.ok(body.trim().length > 200, `${name} body is meaningful`);
  }
});

test("descriptions equal the reviewed invocation hints", () => {
  const { skills } = loadSkillsFromDir({ dir: SKILLS, source: "test" });
  for (const [name, description] of Object.entries(EXPECTED)) {
    assert.equal(skills.find((s) => s.name === name)?.description, description, name);
  }
});

test("the sol-loop trigger is verbatim and its license ships with it", () => {
  assert.equal(readSkill("sol-loop").frontmatter.description, 'Use when the user says "sol loop".');
  const license = readFileSync(join(SKILLS, "sol-loop/LICENSE"), "utf8");
  for (const needle of ["MIT License", "Copyright (c) 2026 Theo Browne", "Permission is hereby granted", "The above copyright notice and this permission notice", 'THE SOFTWARE IS PROVIDED "AS IS"', "LIABILITY"]) {
    assert.ok(license.includes(needle), needle);
  }
});

test("sol-loop keeps provenance out of the runtime body and uses the native contract", () => {
  const { body } = readSkill("sol-loop");
  assert.ok(!/t3dotgg|tstack|github\.com/i.test(body), "no provenance in the runtime body");
  assert.ok(!/wait_agent|stop_agent|force:\s*true/.test(body.replace(/Never pass `force`|no stop tool/g, "")), "no invented tools or cap override");
  for (const needle of ['subagent_type: "sol-reviewer"', "get_subagent_result", "at most 3 review attempts", "Incomplete"]) assert.ok(body.includes(needle), needle);
});

test("real parser diagnostics: folded and quoted descriptions parse, a missing description is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-test."));
  try {
    const write = (name, front) => {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n${front}---\n\nBody.\n`);
    };
    write("quoted", "description: 'Use when the user says \"x\".'\n");
    write("folded", "description: >\n  Use when a folded\n  line is parsed.\n");
    write("missing", "license: MIT\n");
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "test" });
    const byName = Object.fromEntries(skills.map((s) => [s.name, s.description]));
    assert.equal(byName.quoted, 'Use when the user says "x".');
    assert.equal(byName.folded.trim(), "Use when a folded line is parsed.");
    assert.ok(!("missing" in byName));
    assert.ok(diagnostics.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertCaseShape(c, names) {
  assert.ok(typeof c.request === "string" && c.request && typeof c.rationale === "string" && c.rationale);
  assert.ok(Array.isArray(c.load) && Array.isArray(c.notLoad));
  for (const n of [...c.load, ...c.notLoad]) assert.ok(names.has(n), `unknown skill ${n}`);
  assert.ok(!c.load.some((n) => c.notLoad.includes(n)), c.request);
}

test("routing fixtures are well formed, reference owned skills and cover each skill both ways", () => {
  const { cases } = JSON.parse(readFileSync(join(REPO, "tests/fixtures/skills/routing.json"), "utf8"));
  const names = new Set(Object.keys(EXPECTED));
  assert.ok(Array.isArray(cases) && cases.length > 0);
  cases.forEach((c) => assertCaseShape(c, names));
  for (const n of names) {
    assert.ok(cases.some((c) => c.load.includes(n)), `${n} has a positive case`);
    assert.ok(cases.some((c) => c.notLoad.includes(n)), `${n} has a negative case`);
  }
  // Every case that loads sol-loop mentions the phrase; the discussion case must not load it.
  for (const c of cases.filter((c) => c.load.includes("sol-loop"))) assert.match(c.request, /sol loop/i);
});

// ---- review workflow cache boundary (no reviewer or model runs) ----
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const reviewSource = readFileSync(join(REPO, "agent/workflows/review.js"), "utf8").replace(/export const meta = \{[\s\S]*?\n\}\n/, "");
assert.ok(!reviewSource.includes("export const meta"), "meta declaration removed for evaluation");

async function runReview(args) {
  let calls = 0;
  const agent = async () => { calls++; return { summary: "ok", findings: [], verdicts: [] }; };
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item) => { let v = item; for (const s of stages) v = await s(v, item); return v; }));
  const fn = new AsyncFunction("args", "agent", "pipeline", "phase", "log", reviewSource);
  const result = await fn(args, agent, pipeline, () => {}, () => {});
  return { result, calls };
}

const base = { target: "git diff A..B in /repo", context: "issue 60", author: "gpt", round: 1, baseSha: "a".repeat(40), headSha: "b".repeat(40) };

test("an unchanged passing full result is reused with zero reviewer calls", async () => {
  const first = await runReview(base);
  assert.equal(first.result.passed, true);
  assert.ok(first.calls > 0 && first.result.reviewCacheKey);
  const second = await runReview({ ...base, cachedReview: first.result });
  assert.equal(second.calls, 0);
  assert.equal(second.result.cached, true);
});

test("any changed identity field defeats reuse", async () => {
  const { result } = await runReview(base);
  const deep = { deep: true, deepReason: "security", deepJustification: "auth change" };
  const variants = [
    { headSha: "c".repeat(40) }, { baseSha: "c".repeat(40) }, { target: "git diff A..C in /repo" },
    { context: "issue 61" }, { author: "claude" }, deep,
  ];
  for (const change of variants) {
    const { calls, result: r } = await runReview({ ...base, ...change, cachedReview: result });
    assert.ok(calls > 0, JSON.stringify(change));
    assert.notEqual(r.cached, true);
  }
});

test("quick, follow-up, incomplete and unverified results are not eligible", async () => {
  const { result } = await runReview(base);
  const quick = await runReview({ ...base, quick: true, cachedReview: result });
  assert.ok(quick.calls > 0 && quick.result.cached !== true);
  const followUp = await runReview({ ...base, round: 2, since: "c".repeat(40), prior: "none", cachedReview: result });
  assert.ok(followUp.calls > 0 && followUp.result.cached !== true);
  for (const spoiled of [{ complete: false }, { incomplete: ["x"] }, { unverifiedCount: 1 }, { unverified: ["x"] }, { blockingCount: 1 }, { passed: false }]) {
    const r = await runReview({ ...base, cachedReview: { ...result, ...spoiled } });
    assert.ok(r.calls > 0 && r.result.cached !== true, JSON.stringify(spoiled));
  }
});

test("a standalone Sol result is not a full-review cache entry", async () => {
  const malformed = [
    { mode: "quick", round: 1, passed: true, reviewedBy: "GPT-6.1 Sol", blockingCount: 0, blocking: [], advisory: [] },
    { passed: true, complete: true, mode: "full", blockingCount: 0, unverifiedCount: 0, incomplete: [], blocking: [], unverified: [], reviewCacheKey: "review-v1:forged" },
    { verdict: "APPROVE", reviewer: "sol-reviewer" },
  ];
  for (const cachedReview of malformed) {
    const r = await runReview({ ...base, cachedReview });
    assert.ok(r.calls > 0 && r.result.cached !== true, JSON.stringify(cachedReview));
  }
});
