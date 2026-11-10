// Source checks for the shipped skills: real pi frontmatter parsing and discovery, reviewed description
// snapshots, routing-fixture shape, and the review workflow's cache boundary that the sol-loop skill documents.
// Nothing here calls a model or proves LLM routing quality. Run: node --test tools/skills.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(REPO, "skills");

test("every output-cap agent also loads subagent-cache immediately after it", () => {
  const roots = [join(REPO, "agent/agents"), ...readdirSync(join(REPO, "agent/profiles"))
    .map((name) => join(REPO, "agent/profiles", name, "agents")).filter(existsSync)];
  let checked = 0;
  for (const root of roots) for (const name of readdirSync(root).filter((n) => n.endsWith(".md"))) {
    const line = readFileSync(join(root, name), "utf8").match(/^extensions:.*$/m)?.[0] ?? "";
    if (!line.includes("output-cap")) continue;
    checked++;
    assert.match(line, /output-cap, subagent-cache[,\]]/, join(root, name));
  }
  assert.ok(checked > 0);
});

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
  "report-setup-issue": "Use when a reproducible defect or misleading output comes from the pi setup, its bundled tools, skills, guards, profiles or packages, rather than project code or user error.",
  "sol-loop": 'Use when the user says "sol loop".',
  "ai-work-lifecycle": "Use before creating disposable task outputs, running verification that leaves local artifacts, or closing a task with temporary artifacts.",
  "dev-machine-performance": "Use when local gates or phase queues are slow, the machine is swapping, or Docker shows memory pressure. Not for application-runtime performance tuning.",
  "github-issue-hygiene": "Use when starting work on, creating, commenting on, updating the description of, or finishing work on a GitHub issue, and during post-work cleanup to close completed, duplicate or obsolete issues.",
  "ci-and-pushing": "Use before pushing a branch, when waiting on or cancelling GitHub Actions runs, or when local Docker must stay available for CI-like runs.",
  "shipping-trains": "Use when finishing work in a repository that ships through release trains: folding branches into a train, delivering to a repo orchestrator, merging, or handing off a green PR.",
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

test("report-setup-issue keeps ownership, authorization and redaction explicit", () => {
  const { body } = readSkill("report-setup-issue");
  for (const owner of ["woksin/pi-setup", "woksin/pi-jobs", "woksin/pi-recover", "woksin/pi-context-budget", "woksin/pi-orch", "gotgenes/pi-anthropic-auth", "tintinweb/pi-subagents", "vigolium/piolium", "dondai44423/donsetch", "0xPlayerOne/pi-browser-use", "nicobailon/pi-mcp-adapter", "nicobailon/pi-web-access", "earendil-works/pi", "codescene-oss/codescene-mcp-server"]) assert.ok(body.includes(owner), owner);
  for (const text of ["gh issue list", "--state all", "gh issue comment", "standing user", "explicit", "secrets", "tokens", "personal paths", "private repo names", "session content", "Never patch the live install", "## What happened", "## Expected", "## Versions"]) assert.ok(body.includes(text), text);
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

// ---- review workflow cache and runtime provenance (no reviewer or model runs) ----
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const reviewFiles = ["agent/workflows/review.js", ...["anthropic-heavy", "balanced", "balanced-anthropic", "balanced-openai", "kimi-heavy", "lean", "openai-heavy", "openai-only"].map(name => `agent/profiles/${name}/workflows/review.js`)];
function loadReview(file = reviewFiles[0]) {
  return readFileSync(join(REPO, file), "utf8").replace(/export const meta = \{[\s\S]*?\n\}\n/, "");
}
const reviewSource = loadReview();
assert.ok(!reviewSource.includes("export const meta"), "meta declaration removed for evaluation");

function modelMap(file) {
  const declaration = loadReview(file).match(/const AGENT_MODELS = (\{[\s\S]*?\n\})/);
  assert.ok(declaration, file);
  return new Function(`return (${declaration[1]})`)();
}
function provenance(model, label) {
  return { source: "model-provenance/v1", runtimeStamp: "model-provenance/tool-call/v1", session: `session-${label}`, agent: "reviewer#fixture",
    initial: model, models: [model], modelCounts: { [model]: 3 }, assistants: 3, errors: 0, firstAt: "2026-10-27T00:00:00Z", lastAt: "2026-10-27T00:01:00Z", switches: [] };
}
async function runReview(args, { file = reviewFiles[0], override, agentError } = {}) {
  const calls = [];
  const models = modelMap(file);
  const agent = async (prompt, opts) => {
    calls.push({ ...opts, prompt });
    assert.ok(!prompt.includes("runtimeStamp"));
    assert.ok(!prompt.includes("model-provenance/tool-call/v1"));
    assert.ok(!JSON.stringify(opts.schema).includes("runtimeProvenance"));
    const res = { summary: "ok", findings: [], coverage: "complete", verdicts: [], runtimeProvenance: provenance(models[opts.agentType], opts.label) };
    return override ? override(opts, res) : res;
  };
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item) => { let v = item; for (const s of stages) v = await s(v, item); return v; }));
  const parallel = async fns => Promise.all(fns.map(fn => fn().catch(() => null)));
  const fn = new AsyncFunction("args", "agent", "pipeline", "parallel", "phase", "log", "agentError", loadReview(file));
  const result = await fn(args, agent, pipeline, parallel, () => {}, () => {}, agentError);
  return { result, calls: calls.length, requests: calls };
}

const base = { target: "git diff A..B in /repo", context: "issue 60", author: "gpt", round: 1, baseSha: "a".repeat(40), headSha: "b".repeat(40) };

const partialGpt = (opts, res) => ({ ...res, ...(opts.label === "review:gpt" ? { coverage: "partial" } : {}) });
async function repairSeed(options = {}) {
  return (await runReview(base, { override: partialGpt, ...options })).result;
}
async function assertRepairRejected(repair, change = {}) {
  const run = await runReview({ ...base, repair, ...change });
  assert.equal(run.calls, 0);
  assert.equal(run.result.passed, false);
  assert.ok(run.result.error);
  return run.result;
}

for (const file of reviewFiles) {
  test(`${file}: repair retries only the missing lane without mutating the earlier result`, async () => {
    for (const mode of [{}, { deep: true, deepReason: "security", deepJustification: "auth change" }]) {
      const args = { ...base, ...mode };
      const missing = file.includes("openai-only") ? "astra" : "gpt";
      const first = await runReview(args, { file, override: (opts, res) => {
        withClaims(opts, res);
        if (opts.label === `review:${missing}`) res.coverage = "partial";
        return res;
      } });
      assert.equal(first.result.passed, false);
      assert.deepEqual(first.result.repair.missing, [missing]);
      assert.equal(first.result.reviewCacheKey, undefined);
      assert.ok(first.result.repair.completed.some(r => r.label.startsWith("verify:")));
      const before = structuredClone(first.result);
      const fixed = await runReview({ ...args, repair: first.result }, { file });
      assert.deepEqual(fixed.requests.map(r => r.label), [`review:${missing}`]);
      assert.equal(fixed.result.passed, true);
      assert.equal(fixed.result.repaired, true);
      assert.equal(fixed.result.repairAttempt, 1);
      assert.equal(fixed.result.reviewCacheKey, undefined);
      assert.equal(fixed.result.reviewers.length, 5);
      assert.deepEqual(fixed.result.reviewers.filter(r => r.label.startsWith("review:")).map(r => r.label), first.requests.filter(r => r.label.startsWith("review:")).map(r => r.label).sort());
      assert.deepEqual(first.result, before);
    }
  });
}

test("repair retries are bounded independently of the unchanged review round", async () => {
  const first = await repairSeed();
  const second = await runReview({ ...base, repair: first }, { override: partialGpt });
  assert.equal(second.result.passed, false);
  assert.equal(second.result.complete, false);
  assert.equal(second.result.repair.attempt, 2);
  assert.equal(second.result.round, 1);
  const third = await runReview({ ...base, repair: second.result }, { override: partialGpt });
  assert.equal(third.result.repair.attempt, 3);
  assert.match((await assertRepairRejected(third.result)).error, /ask the user/);
});

test("a still-incomplete repair preserves newly completed lanes for the last attempt", async () => {
  const first = await runReview(base, { override: (opts, res) => ({ ...res, coverage: opts.label === "review:claude" ? "complete" : "partial" }) });
  assert.deepEqual(first.result.repair.missing, ["gpt", "security-claude"]);
  const second = await runReview({ ...base, repair: first.result }, { override: partialGpt });
  assert.deepEqual(second.requests.map(r => r.label), ["review:gpt", "review:security-claude"]);
  assert.deepEqual(second.result.repair.missing, ["gpt"]);
  assert.deepEqual(second.result.repair.completed.map(r => r.label), ["review:claude", "review:security-claude"]);
  const fixed = await runReview({ ...base, repair: second.result });
  assert.equal(fixed.result.passed, true);
  assert.equal(fixed.result.repairAttempt, 2);
  assert.deepEqual(fixed.requests.map(r => r.label), ["review:gpt"]);
  assert.equal(fixed.result.reviewers.length, 3);
});

test("repair rejects identity drift and incompatible arguments before spending", async () => {
  const repair = await repairSeed();
  for (const change of [
    { headSha: "c".repeat(40) }, { baseSha: "c".repeat(40) }, { headSha: undefined }, { baseSha: undefined },
    { target: "other scope" }, { context: "other intent" }, { author: "claude" }, { round: 2 },
    { deep: true, deepReason: "security", deepJustification: "auth change" }, { quick: true },
    { since: "c".repeat(40), prior: "none", round: 2 }, { prior: "none", round: 2 }, { cachedReview: {} },
  ]) await assertRepairRejected(repair, change);
  for (const invalid of [null, [], "result", {}, { ...repair, repair: undefined }, { ...repair, passed: true },
    { ...repair, mode: "quick" }, { ...repair, mode: "deep" }, (await runReview(base)).result]) {
    await assertRepairRejected(invalid);
  }
});

test("repair rejects altered evidence, including malformed partition receipts", async () => {
  const first = await repairSeed();
  const edits = [
    r => { r.repair.missing = []; }, r => { delete r.repair.missing; },
    r => { r.repair.missing = ["unknown"]; }, r => { r.repair.missing.push("gpt"); },
    r => { r.repair.missing = ["claude"]; }, r => { r.repair.completed.pop(); },
    r => { r.repair.completed.push(r.repair.completed[0]); },
    r => { r.repair.completed.push({ ...r.repair.completed[0], label: "review:gpt" }); },
    r => { r.repair.completed[0].expected = "other/model"; },
    r => { r.repair.completed[0].effective = ["other/model"]; },
    r => { r.repair.completed[0].ok = false; }, r => { r.repair.completed[0].agentType = "other"; },
    r => { r.repair.completed[0].provenance = "unavailable (pre-update session)"; },
    r => { r.repair.advisory.push("new advisory"); }, r => { r.repair.coverageNotes.push("new note"); },
    r => { r.repair.preExisting.push("new hole"); }, r => { r.repair.attempt++; },
    r => { r.repair.round++; }, r => { r.round++; }, r => { r.repair.key += "x"; },
    r => { r.repair.missing = []; r.repair.completed = Array.from({ length: 3 }, (_, i) => ({ ...r.repair.completed[0], label: `review:${i}` })); },
  ];
  for (const edit of edits) { const altered = structuredClone(first); edit(altered); await assertRepairRejected(altered); }
});

test("blocking, unverified, all-missing and runtime failures never issue repair evidence", async () => {
  for (const status of ["blocks", "uncertain"]) {
    const run = await runReview(base, { override: (opts, res) => {
      if (opts.label === "review:gpt") res.coverage = "partial";
      if (opts.label === "review:claude") res.findings = [blockingClaim(0)];
      if (opts.label.startsWith("verify:")) res.verdicts = [{ index: 0, status, reason: "checked" }];
      return res;
    } });
    assert.equal(run.result.passed, false);
    assert.equal(run.result.repair, undefined);
  }
  const first = await repairSeed();
  const blocked = await runReview({ ...base, repair: first }, { override: (opts, res) => {
    if (opts.label.startsWith("review:")) res.findings = [blockingClaim(0)];
    else res.verdicts = [{ index: 0, status: "blocks", reason: "confirmed" }];
    return res;
  } });
  assert.equal(blocked.result.passed, false);
  assert.equal(blocked.result.blockingCount, 1);
  assert.equal(blocked.result.repair, undefined);
  const allMissing = await runReview(base, { override: (_opts, res) => ({ ...res, coverage: "partial" }) });
  assert.equal(allMissing.result.repair, undefined);
  const fallback = await runReview(base, { override: (opts, res) => opts.label === "review:gpt"
    ? withFallback({ ...res, coverage: "partial" }, ["kimi/moonshot-v1-128k"]) : res });
  assert.equal(fallback.result.repair, undefined);
  const wrong = await runReview({ ...base, repair: first }, { override: (_opts, res) => withFallback(res, ["kimi/moonshot-v1-128k"]) });
  assertUncertified(wrong.result);
  assert.equal(wrong.result.repair, undefined);
});

test("repair preserves advisory and security scope and requires reusable original provenance", async () => {
  const seed = await runReview(base, { override: (opts, res) => {
    if (opts.label === "review:security-claude") res.coverage = "partial";
    if (opts.label === "review:claude") {
      res.findings = [{ ...blockingClaim(0), blocking: false, problem: "PRE-EXISTING: preserved hole" }];
      res.coverageNote = "UNRUN: browser: unavailable";
    }
    return res;
  } });
  const fixed = await runReview({ ...base, repair: seed.result });
  assert.equal(fixed.result.passed, true);
  assert.deepEqual(fixed.requests.map(r => r.label), ["review:security-claude"]);
  assert.match(fixed.requests[0].prompt, /SECURITY lens/);
  assert.match(fixed.requests[0].prompt, /git diff A\.\.B/);
  assert.ok(fixed.result.advisory.some(line => line.includes("preserved hole")));
  assert.ok(fixed.result.preExistingSecurity.some(line => line.includes("preserved hole")));
  assert.ok(fixed.result.coverageNotes.some(line => line.includes("UNRUN")));
  const absent = await runReview(base, { override: (opts, res) => {
    if (opts.label === "review:claude") res.runtimeProvenance = undefined;
    return partialGpt(opts, res);
  } });
  assert.deepEqual(absent.result.repair.missing, ["claude", "gpt"]);
  assert.deepEqual(absent.result.repair.completed.map(r => r.label), ["review:security-claude"]);
  const unavailable = await runReview({ ...base, repair: seed.result }, { override: (_opts, res) => ({ ...res, runtimeProvenance: undefined }) });
  assert.equal(unavailable.result.passed, false);
  assert.equal(unavailable.result.complete, false);
  assert.deepEqual(unavailable.result.repair.missing, ["security-claude"]);
});

test("repair receipts and combined results fit the notification bound", async () => {
  const seed = await runReview(base, { override: (opts, res) => {
    withClaims(opts, res);
    res.coverageNote = "UNRUN: " + "x".repeat(300);
    if (opts.label === "review:gpt") res.coverage = "partial";
    else if (opts.label.startsWith("review:")) res.findings.push(...Array.from({ length: 5 }, (_, i) => ({ ...blockingClaim(i), blocking: false, problem: "PRE-EXISTING: " + "x".repeat(300) })));
    return res;
  } });
  assert.ok(seed.result.repair);
  assert.ok(JSON.stringify(seed.result, null, 2).length <= 3900, JSON.stringify(seed.result, null, 2).length);
  const fixed = await runReview({ ...base, repair: seed.result }, { override: withClaims });
  assert.equal(fixed.result.passed, true);
  assert.ok(JSON.stringify(fixed.result, null, 2).length <= 3900, JSON.stringify(fixed.result, null, 2).length);
  const again = await runReview({ ...base, repair: seed.result }, { override: (opts, res) => {
    withClaims(opts, res);
    res.coverage = "partial";
    res.coverageNote = "x".repeat(300);
    res.findings.push(...Array.from({ length: 5 }, (_, i) => ({ ...blockingClaim(i), blocking: false, problem: "PRE-EXISTING: " + "x".repeat(300) })));
    return res;
  } });
  assert.ok(again.result.repair);
  assert.ok(JSON.stringify(again.result, null, 2).length <= 3900, JSON.stringify(again.result, null, 2).length);
});

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

test("runtime StructuredOutput preserves hook-injected provenance with every actual review schema", async () => {
  const subagents = join(findPiModules(), "@tintinweb/pi-subagents/dist");
  // Use the same typebox/value Check as compileJsonSchema. pi's dependency may be nested,
  // rather than hoisted where the optional subagents peer dependency resolves it.
  const requirePi = createRequire(join(findPiModules(), "@earendil-works/pi-coding-agent/package.json"));
  const { Check } = await import(pathToFileURL(requirePi.resolve("typebox/value")));
  const { createStructuredCapture, createStructuredOutputTool } = await import(pathToFileURL(join(subagents, "structured-output.js")));
  const { default: register } = await import(pathToFileURL(join(REPO, "agent/extensions/model-provenance.ts")));
  let hook;
  register({ on: (name, handler) => { if (name === "tool_call") hook = handler; } });
  for (const file of reviewFiles) {
    const declarations = [...loadReview(file).matchAll(/const (FINDINGS|VERDICTS) = (\{[\s\S]*?\n\})/g)].map(match => match[0]);
    assert.equal(declarations.length, 2, file);
    const coverage = loadReview(file).match(/const COVERAGE = [\s\S]*?(?=\nconst coverageNotesFor)/)?.[0];
    assert.ok(coverage, file);
    const schemas = new Function(`${coverage};\n${declarations.join(";\n")}; return { FINDINGS, VERDICTS };`)();
    for (const [name, schema] of Object.entries(schemas)) {
      const compiled = { schema, check: value => Check(schema, value) ? true : "schema mismatch" };
      const input = name === "FINDINGS" ? { summary: "ok", findings: [], coverage: "complete" } : { verdicts: [] };
      assert.equal(compiled.check(input), true, "valid before the hook");
      const model = modelMap(file).reviewer;
      const [provider, id] = model.split("/");
      hook({ toolName: "StructuredOutput", input }, { hasUI: false, sessionManager: {
        getSessionId: () => "runtime-contract", getBranch: () => [
          { type: "model_change", provider, modelId: id, timestamp: "2026-10-27T00:00:00Z" },
          { type: "session_info", name: "reviewer#runtime-contract" },
          { type: "message", timestamp: "2026-10-27T00:00:01Z", message: { role: "assistant", provider, model: id, stopReason: "stop" } },
        ],
      } });
      assert.deepEqual(input.runtimeProvenance.models, [model]);
      assert.equal(compiled.check(input), true, `${file} ${name}: valid after the hook`);
      const capture = createStructuredCapture();
      const result = await createStructuredOutputTool(compiled, capture).execute("runtime-contract", input);
      assert.notEqual(result.isError, true, `${file} ${name}`);
      assert.deepEqual(JSON.parse(capture.json), input, "runtimeProvenance survives execute-time validation and capture");
    }
  }
});

test("review routing, runtime wrapper and schemas stay synchronized across all profiles", () => {
  const wrapper = source => source.slice(source.indexOf("const runtimeRuns ="), source.indexOf("// End runtime recording."));
  for (const file of reviewFiles) {
    const source = loadReview(file);
    const models = modelMap(file);
    assert.deepEqual(Object.keys(models).sort(), ["reviewer", "second-opinion", "sol-reviewer"]);
    for (const [agentType, expected] of Object.entries(models)) {
      const dir = file.replace(/workflows\/review\.js$/, "agents");
      const frontmatter = readFileSync(join(REPO, dir, `${agentType}.md`), "utf8").split("---")[1];
      assert.equal(frontmatter.match(/^model: (.+)$/m)?.[1], expected, `${file}: ${agentType}`);
      assert.match(frontmatter.match(/^extensions: (.+)$/m)?.[1] ?? "", /\bmodel-provenance\b/);
    }
    for (const [, agentType] of source.matchAll(/agentType:\s*'([^']+)'/g)) assert.ok(models[agentType], `${file}: ${agentType}`);
    assert.equal(wrapper(source), wrapper(reviewSource), `${file}: identical runtime wrapper`);
    assert.ok(!source.includes("additionalProperties"), `${file}: schemas must accept injected provenance`);
    assert.ok(!source.includes("review-v1:"), `${file}: no legacy cache prefix`);
    if (source.includes("const cacheKey")) assert.match(source, /const cacheKey = 'review-v4-coverage:'/);
  }
  for (const profile of ["balanced", "balanced-openai", "lean"]) assert.equal(loadReview(`agent/profiles/${profile}/workflows/review.js`), reviewSource);
});

const blockingClaim = index => ({ severity: "major", blocking: true, location: `src/a.ts:${index + 1}`,
  problem: `regression ${index}`, fix: "restore required behavior" });
function withClaims(opts, res) {
  if (opts.label.startsWith("review:")) res.findings = [blockingClaim(0)];
  else res.verdicts = [{ index: 0, status: "refuted", reason: "checked source" }];
  return res;
}
function withFallback(res, models, when = "before-first-response") {
  const expected = res.runtimeProvenance.models[0];
  res.runtimeProvenance.models = models;
  res.runtimeProvenance.modelCounts = Object.fromEntries(models.map((model, i) => [model, i === 0 ? 4 - models.length : 1]));
  res.runtimeProvenance.switches = [{ at: "2026-10-27T00:00:00Z", from: expected, to: "kimi/moonshot-v1-128k", when, reason: "usage limit" }];
  return res;
}
function assertUncertified(result) {
  assert.equal(result.complete, false);
  assert.equal(result.passed, false);
  assert.ok(result.incomplete.length > 0);
  assert.equal(result.reviewCacheKey, undefined);
  assert.match(result.next, /Do not rerun or override/);
}

for (const file of reviewFiles) {
  test(`${file}: correct full/deep/quick model records certify and preserve provenance`, async () => {
    const full = await runReview(base, { file });
    assert.equal(full.result.passed, true);
    assert.equal(full.result.complete, true);
    assert.equal(full.calls, 3, "two general reviews plus the security lane");
    assert.equal(full.result.reviewers.length, 3);
    assert.equal(full.requests.filter(r => r.label.startsWith("review:security-")).length, 1);
    assert.ok(full.result.reviewers.every(run => run.ok && run.effective.length === 1 && run.expected === run.effective[0]));
    const deep = await runReview({ ...base, deep: true, deepReason: "security", deepJustification: "auth change" }, { file, override: withClaims });
    assert.equal(deep.result.passed, true);
    assert.equal(deep.calls, 6);
    assert.equal(deep.result.reviewers.length, 6);
    assert.equal(deep.requests.filter(r => r.label.startsWith("verify:security-")).length, 1, "security findings are verified");
    const labels = deep.result.reviewers.map(run => run.label);
    assert.deepEqual(labels, [...labels].sort());
    for (const request of deep.requests) assert.equal(request.model, undefined, "no model overrides");
    const quick = await runReview({ ...base, quick: true }, { file });
    assert.equal(quick.calls, 2, "main review plus the security lens");
    assert.equal(quick.requests.filter(r => r.label.startsWith("review:security-")).length, 1);
    assert.equal(quick.result.passed, true);
    assert.equal(quick.result.complete, true);
    assert.equal(quick.result.reviewers.length, 2);
  });

  test(`${file}: initial and mid-review fallback preserve six calls but cannot certify`, async () => {
    for (const when of ["before-first-response", "after-request-failure", "mid-review"]) {
      const run = await runReview(base, { file, override: (opts, res) => {
        withClaims(opts, res);
        if (opts.label.startsWith("review:")) withFallback(res,
          when === "before-first-response" ? ["kimi/moonshot-v1-128k"] : [...res.runtimeProvenance.models, "kimi/moonshot-v1-128k"], when);
        return res;
      } });
      assertUncertified(run.result);
      assert.equal(run.calls, 6, "no skipped verification or reruns");
      assert.equal(run.result.reviewers.length, 6);
      assert.equal(run.result.reviewers.filter(r => typeof r === "string" ? r.endsWith("INCOMPLETE") : !r.ok).length, 3, "the three review lanes fell back; verifiers are fine (records are compacted to strings when oversized)");
      const text = run.result.incomplete.join(" ");
      assert.match(text, /kimi\/moonshot-v1-128k/);
      assert.match(text, when === "before-first-response" ? /before its first response/ : when === "after-request-failure" ? /after a failed request/ : /during the review/);
      for (const request of run.requests) assert.equal(request.model, undefined);
    }
  });

  test(`${file}: verifier fallback is checked independently`, async () => {
    const run = await runReview(base, { file, override: (opts, res) => {
      withClaims(opts, res);
      return opts.label.startsWith("verify:") ? withFallback(res, ["kimi/moonshot-v1-128k"]) : res;
    } });
    assertUncertified(run.result);
    assert.equal(run.calls, 6);
    assert.ok(run.result.incomplete.every(problem => problem.includes("verify:")));
  });

  for (const absent of [undefined, null]) {
    for (const mode of ["full", "quick"]) {
      test(`${file}: ${mode} absent (${String(absent)}) provenance is accepted as transitional, marked unavailable and never cached`, async () => {
        const args = mode === "full" ? base : { ...base, quick: true, force: true, allowFallback: true };
        const run = await runReview(args, { file, override: (_opts, res) => ({ ...res, runtimeProvenance: absent }) });
        assert.equal(run.result.passed, true);
        assert.equal(run.result.complete, true);
        assert.equal(run.calls, mode === "full" ? 3 : 2);
        assert.equal(run.requests.filter(request => request.label.startsWith("review:security-")).length, 1);
        for (const reviewer of run.result.reviewers) {
          assert.equal(reviewer.provenance, "unavailable (pre-update session)");
          assert.deepEqual(reviewer.effective, []);
          assert.equal(reviewer.ok, true);
        }
        assert.equal(run.result.reviewCacheKey, undefined);
        if (mode === "full") {
          const rerun = await runReview({ ...base, cachedReview: run.result }, { file });
          assert.equal(rerun.calls, 3);
          assert.notEqual(rerun.result.cached, true);
        }
      });
    }
  }

  if (loadReview(file).includes("const cacheKey")) {
    test(`${file}: absent records cannot be reused even under a valid cache key`, async () => {
      const valid = await runReview(base, { file });
      assert.ok(valid.result.reviewCacheKey);
      for (const absent of [undefined, null]) {
        const run = await runReview(base, { file, override: (_opts, res) => ({ ...res, runtimeProvenance: absent }) });
        const cached = await runReview({ ...base, cachedReview: { ...valid.result, reviewers: run.result.reviewers } }, { file });
        assertUncertified(cached.result);
        assert.equal(cached.calls, 0);
      }
    });
  }

  const invalid = [
    ["empty-object", (_opts, res) => ({ ...res, runtimeProvenance: {} })],
    ["forged-source", (_opts, res) => ({ ...res, runtimeProvenance: { source: "self-reported", models: ["kimi/moonshot-v1-128k"] } })],
    ["empty-models", (_opts, res) => ({ ...res, runtimeProvenance: { source: "model-provenance/v1", models: [] } })],
    ["null-model", (_opts, res) => ({ ...res, runtimeProvenance: { source: "model-provenance/v1", models: [null] } })],
    ["unavailable-field", (_opts, res) => {
      res.runtimeProvenance.unavailable = "runtime session records unavailable";
      return res;
    }],
    ["mismatched", (_opts, res) => withFallback(res, ["kimi/moonshot-v1-128k"])],
  ];
  for (const [name, override] of invalid) {
    for (const mode of ["full", "quick"]) {
      test(`${file}: ${mode} ${name} provenance fails closed`, async () => {
        const args = mode === "full" ? base : { ...base, quick: true, force: true, allowFallback: true };
        const run = await runReview(args, { file, override });
        assertUncertified(run.result);
        assert.equal(run.calls, mode === "full" ? 3 : 2);
        if (name === "mismatched") {
          for (const problem of run.result.incomplete) assert.match(problem, /kimi\/moonshot-v1-128k/);
        } else {
          assert.ok(run.result.incomplete.every(problem => problem.endsWith("no runtime model record")));
        }
      });
    }
  }

  test(`${file}: historical switches and request errors alone do not invalidate coverage`, async () => {
    const run = await runReview(base, { file, override: (_opts, res) => {
      res.runtimeProvenance.errors = 1;
      res.runtimeProvenance.initial = "kimi/moonshot-v1-128k";
      res.runtimeProvenance.switches = [{ from: "kimi/moonshot-v1-128k", to: res.runtimeProvenance.models[0], when: "before-first-response" }];
      return res;
    } });
    assert.equal(run.result.passed, true);
    assert.equal(run.calls, 3);
  });

  test(`${file}: failed review or verification follows existing failure paths`, async () => {
    const reviewFailed = await runReview(base, { file, override: () => null });
    assert.equal(reviewFailed.result.passed, false);
    assert.equal(reviewFailed.result.complete, false);
    assert.equal(reviewFailed.calls, 3);
    const verifyFailed = await runReview(base, { file, override: (opts, res) => opts.label.startsWith("review:") ? withClaims(opts, res) : null });
    assert.equal(verifyFailed.result.passed, false);
    assert.equal(verifyFailed.result.complete, false);
    assert.equal(verifyFailed.calls, 6);
  });
}

test("matching caches without complete reviewer evidence fail INCOMPLETE without rerunning", async () => {
  for (const file of reviewFiles.filter(file => loadReview(file).includes("const cacheKey"))) {
    const { result } = await runReview(base, { file, override: withClaims });
    assert.equal(result.reviewers.length, 6);
    const corruptions = [undefined, [], result.reviewers.slice(1), result.reviewers.filter(run => !run.label.includes("security")), result.reviewers.filter(run => !run.label.startsWith("verify:")),
      result.reviewers.map(run => ({ ...run, effective: ["kimi/moonshot-v1-128k"], modelCounts: { "kimi/moonshot-v1-128k": run.assistants } })),
      result.reviewers.map(run => run.label.startsWith("verify:") ? { ...run, effective: ["kimi/moonshot-v1-128k"], modelCounts: { "kimi/moonshot-v1-128k": run.assistants } } : run)];
    for (const reviewers of corruptions) {
      const cached = await runReview({ ...base, cachedReview: { ...result, reviewers } }, { file });
      assertUncertified(cached.result);
      assert.equal(cached.calls, 0, "invalid cache must not trigger a retry");
    }
    const unchanged = await runReview({ ...base, cachedReview: result }, { file });
    assert.equal(unchanged.result.passed, true);
    assert.equal(unchanged.calls, 0);
  }
});

test("cache identity includes profile model routing and rechecks cached role attribution", async () => {
  const shared = await runReview(base);
  const file = "agent/profiles/balanced-anthropic/workflows/review.js";
  const anthropic = await runReview(base, { file });
  assert.notEqual(shared.result.reviewCacheKey, anthropic.result.reviewCacheKey);
  const crossProfile = await runReview({ ...base, cachedReview: shared.result }, { file });
  assert.ok(crossProfile.calls > 0);
  assert.notEqual(crossProfile.result.cached, true);
  const forgedIdentity = await runReview({ ...base, cachedReview: { ...shared.result, reviewCacheKey: anthropic.result.reviewCacheKey } }, { file });
  assertUncertified(forgedIdentity.result);
  assert.equal(forgedIdentity.calls, 0);
});

for (const file of reviewFiles) {
  test(`${file}: minimal imitation and inconsistent full-shape metadata fail closed`, async () => {
    const minimal = await runReview(base, { file, override: (_opts, res) => ({ ...res,
      runtimeProvenance: { source: "model-provenance/v1", models: res.runtimeProvenance.models } }) });
    assertUncertified(minimal.result);
    for (const changes of [{ runtimeStamp: undefined }, { session: "" }, { agent: undefined }, { initial: undefined },
      { switches: undefined }, { assistants: 0 }, { firstAt: undefined },
      { lastAt: "not a timestamp" }, { firstAt: "2027-10-27T00:00:00Z" }, { modelCounts: {} },
      { modelCounts: { "kimi/moonshot-v1-128k": 3 } }, { assistants: 4 }, { errors: 4 }]) {
      const run = await runReview(base, { file, override: (_opts, res) => ({ ...res,
        runtimeProvenance: { ...res.runtimeProvenance, ...changes } }) });
      assertUncertified(run.result);
    }
  });
}

test("review-v1 cache results cannot bypass runtime provenance enforcement", async () => {
  const { result } = await runReview(base);
  assert.match(result.reviewCacheKey, /^review-v4-coverage:/);
  const old = { ...result, reviewCacheKey: result.reviewCacheKey.replace("review-v4-coverage:", "review-v1:") };
  const run = await runReview({ ...base, cachedReview: old });
  assert.equal(run.calls, 3);
  assert.notEqual(run.result.cached, true);
});

test("a pre-coverage (review-v2) cached pass is not reused", async () => {
  const { result } = await runReview(base);
  const legacy = { ...result, reviewCacheKey: result.reviewCacheKey.replace("review-v4-coverage:", "review-v2-security:") };
  for (const file of reviewFiles.filter(f => !f.includes("openai-only"))) {
    const fresh = await runReview(base, { file });
    if (!fresh.result.reviewCacheKey) continue;
    const old = { ...fresh.result, reviewCacheKey: fresh.result.reviewCacheKey.replace("review-v4-coverage:", "review-v2-security:") };
    const run = await runReview({ ...base, cachedReview: old }, { file });
    assert.ok(run.calls > 0, file);
    assert.notEqual(run.result.cached, true, file);
  }
  const run = await runReview({ ...base, cachedReview: legacy });
  assert.ok(run.calls > 0);
  assert.notEqual(run.result.cached, true);
});

// ---- a reviewer slot that did not fully review is never a pass ----
for (const file of reviewFiles) {
  test(`${file}: coverage describes examined scope and complete unrun checks are notes`, async () => {
    const source = loadReview(file);
    assert.match(source, /every file and section of the requested scope was examined/);
    assert.match(source, /some file, hunk or section in scope was NOT examined/);
    assert.match(source, /UNRUN: <check>: <reason>/);
    assert.match(source, /trust-boundary read of every touched path/);
    assert.match(source, /hostile-case spec check/);
    assert.match(source, /target\/brief names as required/);
    for (const mode of [{ quick: true }, {}]) {
      const run = await runReview({ ...base, ...mode }, { file, override: (opts, res) => {
        if (opts.label.startsWith("review:")) {
          assert.match(opts.schema.properties.coverage.description, /even if some verification/);
          res.coverageNote = "UNRUN: browser: unavailable " + "detail ".repeat(200);
        }
        return res;
      } });
      assert.equal(run.result.passed, true);
      assert.deepEqual(run.result.incomplete, []);
      assert.ok(run.result.coverageNotes.length >= 2);
      assert.ok(run.result.coverageNotes.every(n => n.includes("UNRUN: browser: unavailable") && n.length < 260));
      assert.ok(JSON.stringify(run.result, null, 2).length <= 3900);
    }
  });
}

const coverageCases = [{ coverage: "partial", coverageNote: "no repo access" }, { coverage: "none" }, { coverage: undefined }];
for (const file of reviewFiles) {
  test(`${file}: partial, none or missing coverage makes quick and full runs incomplete`, async () => {
    for (const mode of [{ quick: true }, {}]) {
      const ok = await runReview({ ...base, ...mode }, { file });
      assert.equal(ok.result.passed, true, JSON.stringify(mode));
      for (const slot of [opts => opts.label.startsWith("review:") && !securityLabel(opts), securityLabel]) {
        for (const change of coverageCases) {
          const run = await runReview({ ...base, ...mode }, { file, override: (opts, res) => (slot(opts) ? { ...res, ...change } : res) });
          const label = `${JSON.stringify(mode)} ${JSON.stringify(change)}`;
          assert.equal(run.result.passed, false, label);
          assert.equal(run.result.complete, false, label);
          assert.ok(run.result.incomplete.some(m => /did not complete its review/.test(m)), label);
        }
      }
    }
  });
}

test("failed review partitions say why when the host exposes agentError, and degrade to the bare text otherwise", async () => {
  const reason = label => label.startsWith("review:") ? "429 rate_limit_error" : undefined;
  // (a) no hook: unchanged text
  const bare = await runReview(base, { override: () => null });
  assert.ok(bare.result.incomplete.every(t => !t.includes("failed:")), bare.result.incomplete.join("|"));
  assert.ok(bare.result.incomplete.some(t => / review failed$/.test(t)));
  const bareQuick = await runReview({ ...base, quick: true }, { override: () => null });
  assert.match(bareQuick.result.error, /^[^:]+ review failed$/);
  const bareSec = await runReview({ ...base, quick: true }, { override: (opts, res) => opts.label.startsWith("review:security-") ? null : res });
  assert.match(bareSec.result.error, /^.+ security review failed$/);
  // (b) hook present
  const full = await runReview(base, { override: () => null, agentError: reason });
  assert.equal(full.result.incomplete.filter(t => t.endsWith(" review failed: 429 rate_limit_error")).length, 3, full.result.incomplete.join("|"));
  assert.ok(full.result.incomplete.some(t => t.includes("(security) review failed: 429 rate_limit_error")));
  const quick = await runReview({ ...base, quick: true }, { override: () => null, agentError: reason });
  assert.match(quick.result.error, /review failed: 429 rate_limit_error$/);
  const quickSec = await runReview({ ...base, quick: true }, { override: (opts, res) => opts.label.startsWith("review:security-") ? null : res, agentError: reason });
  assert.match(quickSec.result.error, / security review failed: 429 rate_limit_error$/);
  // (c) hostile reasons
  const hostile = 'line1\nline2 "quoted" \\ ' + "x".repeat(500);
  const bad = await runReview(base, { override: () => null, agentError: () => hostile });
  for (const t of bad.result.incomplete) { assert.ok(t.length <= 170); assert.ok(!/[\n"]/.test(t)); }
  assert.ok(bad.result.incomplete.some(t => t.includes("review failed: line1 line2 'quoted'")));
  const thrown = await runReview(base, { override: () => null, agentError: () => { throw new Error("boom"); } });
  assert.deepEqual(thrown.result.incomplete, bare.result.incomplete);
  const nonString = await runReview({ ...base, quick: true }, { override: () => null, agentError: () => ({ a: 1 }) });
  assert.match(nonString.result.error, /^[^:]+ review failed$/);
});

test("fit preserves gate and coverage with nine blockers and six reviewer records", async () => {
  const run = await runReview(base, { override: (opts, res) => {
    if (opts.label.startsWith("review:")) {
      res.summary = "summary ".repeat(100);
      res.findings = [0, 1, 2].map(i => ({ ...blockingClaim(i), problem: `regression ${i} ${"detail ".repeat(50)}` }));
    } else res.verdicts = [0, 1, 2].map(index => ({ index, status: "blocks", reason: "confirmed ".repeat(50) }));
    return res;
  } });
  assert.equal(run.result.passed, false);
  assert.equal(run.result.complete, true);
  assert.equal(run.result.blockingCount, 9);
  assert.equal(run.result.reviewers.length, 6);
  assert.ok(JSON.stringify(run.result, null, 2).length <= 3900);
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

// ---- security lens: a cross-provider reviewer in every mode ----
const securityFinding = { severity: "major", blocking: true, location: "src/auth.ts:9", problem: "caller header skips tenant check", fix: "enforce server-side" };
const preExistingFinding = { severity: "major", blocking: false, location: "src/old.ts:3", problem: "PRE-EXISTING: token logged in plaintext", fix: "mask it" };
const securityLabel = opts => opts.label.startsWith("review:security-");

for (const file of reviewFiles) {
  test(`${file}: the security lane runs in quick and full mode, its blockers gate and PRE-EXISTING items are reported`, async () => {
    for (const mode of [{ quick: true }, {}]) {
      const clean = await runReview({ ...base, ...mode }, { file });
      assert.equal(clean.requests.filter(securityLabel).length, 1, JSON.stringify(mode));
      assert.deepEqual(clean.result.preExistingSecurity, []);
      const blocked = await runReview({ ...base, ...mode }, { file, override: (opts, res) => {
        if (securityLabel(opts)) res.findings = [securityFinding];
        else if (opts.label.startsWith("verify:")) res.verdicts = [{ index: 0, status: "blocks", reason: "reproduced" }];
        return res;
      } });
      assert.equal(blocked.result.passed, false, `${JSON.stringify(mode)}: a security blocker fails the review`);
      assert.equal(blocked.result.blockingCount, 1);
      assert.match(blocked.result.blocking[0].problem, /tenant check/);
      assert.match(blocked.result.blocking[0].foundBy ?? "", /security/);
      const pre = await runReview({ ...base, ...mode }, { file, override: (opts, res) => {
        if (securityLabel(opts)) res.findings = [preExistingFinding];
        return res;
      } });
      assert.equal(pre.result.passed, true, "pre-existing holes are advisory and do not gate");
      assert.equal(pre.result.preExistingSecurity.length, 1);
      assert.match(pre.result.preExistingSecurity[0], /PRE-EXISTING: token logged/);
    }
  });

  test(`${file}: an unverified security blocker in quick mode and a failed security lane fail closed`, async () => {
    const quick = await runReview({ ...base, quick: true }, { file, override: (opts, res) => {
      if (securityLabel(opts)) res.findings = [securityFinding];
      return res;
    } });
    assert.equal(quick.result.passed, false);
    assert.equal(quick.requests.filter(opts => opts.label.startsWith("verify:")).length, 0, "quick mode has no verifier");
    const failed = await runReview({ ...base, quick: true }, { file, override: (opts, res) => securityLabel(opts) ? null : res });
    assert.equal(failed.result.passed, false);
    const failedFull = await runReview(base, { file, override: (opts, res) => securityLabel(opts) ? null : res });
    assert.equal(failedFull.result.passed, false);
    assert.equal(failedFull.result.complete, false);
  });
}

test("a passing full result with security-lane verification is reused for either author", async () => {
  for (const file of reviewFiles.filter(file => loadReview(file).includes("const cacheKey"))) {
    for (const author of ["claude", "gpt"]) {
      const args = { ...base, author };
      const first = await runReview(args, { file, override: withClaims });
      assert.equal(first.result.passed, true, `${file} ${author}`);
      assert.ok(first.requests.some(r => r.label.startsWith("verify:security-")), "security lane verified");
      const again = await runReview({ ...args, cachedReview: first.result }, { file });
      assert.equal(again.result.cached, true, `${file} ${author}`);
      assert.equal(again.calls, 0);
    }
  }
});

// ---- #157: profile workflows are generated from one source ----
test("profile review workflows equal the generator output (node tools/sync-review-workflow.mjs --check)", () => {
  const run = spawnSync(process.execPath, [join(REPO, "tools/sync-review-workflow.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

// ---- #161: results are bounded as delivered (parent notification cuts pretty-printed JSON at 4000) ----
const prettyLength = result => JSON.stringify(result, null, 2).length;
const nasty = "\"\\\n\t\u0001\u2028\ud800 ".repeat(40);
const hostile = text => `${text} ${nasty}`;
const hostileFinding = index => ({ severity: "major", blocking: true, location: hostile(`src/${index}.ts:1`), problem: hostile(`regression ${index}`),
  fix: hostile("restore"), coverage: "complete" });
const adversarial = (opts, res) => {
  res.summary = hostile("summary");
  res.coverageNote = hostile("UNRUN: browser: unavailable");
  if (opts.label.startsWith("review:")) res.findings = [0, 1, 2, 3, 4, 5, 6, 7].map(i => (i < 6 ? hostileFinding(i) : { ...hostileFinding(i), blocking: false, severity: "minor" }));
  else res.verdicts = [0, 1, 2, 3, 4, 5].map(index => ({ index, status: "blocks", reason: hostile("confirmed") }));
  return res;
};

for (const file of reviewFiles) {
  test(`${file}: pretty-printed results stay <= 3900 chars with hostile text and six runs, and keep the verdict`, async () => {
    for (const mode of [{}, { deep: true, deepReason: "security", deepJustification: "auth change" }, { quick: true }]) {
      const blocked = await runReview({ ...base, ...mode }, { file, override: adversarial });
      assert.ok(prettyLength(blocked.result) <= 3900, `${JSON.stringify(mode)} blocked: ${prettyLength(blocked.result)}`);
      assert.equal(blocked.result.passed, false);
      assert.ok(blocked.result.blockingCount >= 6, "blockingCount is the real count");
      assert.ok(blocked.result.blocking.length <= 4 && blocked.result.blocking.some(f => typeof f === "string" && f.includes("more blocking")));
      assert.equal(blocked.result.reviewCacheKey, undefined);
      const clean = await runReview({ ...base, ...mode }, { file, override: (opts, res) => ({ ...res, summary: hostile("s"), findings: opts.label.startsWith("review:")
        ? [0, 1, 2, 3, 4, 5].map(i => ({ ...hostileFinding(i), blocking: false, severity: "minor", problem: hostile(`PRE-EXISTING: p${i}`) })) : [],
        coverageNote: hostile("UNRUN: x: y") }) });
      assert.equal(clean.result.passed, true);
      assert.ok(prettyLength(clean.result) <= 3900, `${JSON.stringify(mode)} passed: ${prettyLength(clean.result)}`);
      if (!mode.quick) {
        assert.match(clean.result.reviewCacheKey, /^review-v4-coverage:/);
        const hit = await runReview({ ...base, ...mode, cachedReview: clean.result }, { file });
        assert.equal(hit.calls, 0);
        assert.equal(hit.result.cached, true);
        assert.equal(hit.result.reviewCacheKey, clean.result.reviewCacheKey);
        assert.ok(prettyLength(hit.result) <= 3900);
        assert.ok(hit.result.reviewers.every(run => run.session === undefined && run.modelCounts === undefined), "cache hits keep slim records");
      }
    }
  });

  test(`${file}: a cache hit enforces unique labels, allowed roles, required lanes, an exact count and bounded output`, async () => {
    const { result } = await runReview(base, { file, override: withClaims });
    assert.equal(result.passed, true);
    const runs = result.reviewers;
    assert.equal(result.runtimeCallCount, runs.length);
    assert.deepEqual(Object.keys(runs[0]).sort(), ["agentType", "effective", "expected", "label", "ok"]);
    const bad = [
      [...runs, runs[0]],
      [...runs.slice(1), runs[1]],
      runs.map((run, i) => (i === 0 ? { ...run, label: "review:other" } : run)),
      runs.map((run, i) => (i === 0 ? { ...run, agentType: "nonexistent" } : run)),
      runs.filter(run => !run.label.startsWith("review:security-")),
      runs.map((run, i) => (i === 0 ? { ...run, ok: false } : run)),
      runs.map((run, i) => (i === 0 ? { ...run, effective: ["kimi/moonshot-v1-128k"] } : run)),
      runs.map((run, i) => (i === 0 ? { ...run, expected: "other/model" } : run)),
      runs.map((run, i) => (i === 0 ? null : run)),
      runs.map((run, i) => (i === 0 ? { ...run, label: hostile("review:x").repeat(20), effective: [nasty.repeat(10)] } : run)),
    ];
    for (const reviewers of bad) {
      for (const runtimeCallCount of [result.runtimeCallCount, reviewers.length]) {
        const hit = await runReview({ ...base, cachedReview: { ...result, reviewers, runtimeCallCount } }, { file });
        assertUncertified(hit.result);
        assert.equal(hit.calls, 0);
        assert.ok(prettyLength(hit.result) <= 3900, String(prettyLength(hit.result)));
      }
    }
    for (const changes of [{ passed: false }, { complete: false }, { blockingCount: 1 }, { unverifiedCount: 1 }, { blocking: [{}] }, { unverified: [{}] }, { incomplete: ["x"] }]) {
      const hit = await runReview({ ...base, cachedReview: { ...result, ...changes } }, { file });
      assert.ok(hit.calls > 0 && hit.result.cached !== true, JSON.stringify(changes));
    }
  });
}

test("transitional runs without provenance pass but never receive a receipt key", async () => {
  const run = await runReview(base, { override: (_opts, res) => ({ ...res, runtimeProvenance: undefined }) });
  assert.equal(run.result.passed, true);
  assert.equal(run.result.reviewCacheKey, undefined);
});

// ---- exactly one verdict per blocking finding; anything else fails closed ----
const verdictCases = {
  "duplicate contradictory verdict": [{ index: 0, status: "refuted", reason: "r" }, { index: 0, status: "blocks", reason: "b" }],
  "duplicate identical verdict": [{ index: 0, status: "refuted", reason: "r" }, { index: 0, status: "refuted", reason: "r" }],
  "extra verdict for an unknown finding": [{ index: 0, status: "refuted", reason: "r" }, { index: 7, status: "refuted", reason: "r" }],
  "missing verdict": [],
};
for (const file of reviewFiles) {
  for (const [name, verdicts] of Object.entries(verdictCases)) {
    test(`${file}: ${name} is never a pass and never cacheable`, async () => {
      const run = await runReview(base, { file, override: (opts, res) => {
        if (opts.label.startsWith("review:")) res.findings = [blockingClaim(0)];
        else res.verdicts = verdicts;
        return res;
      } });
      assert.equal(run.result.passed, false);
      assert.equal(run.result.reviewCacheKey, undefined);
      assert.ok(run.result.unverifiedCount > 0 || run.result.complete === false);
    });
  }
}
