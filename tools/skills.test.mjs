// Source checks for the shipped skills: real pi frontmatter parsing and discovery, reviewed description
// snapshots, routing-fixture shape, and the review workflow's cache boundary that the sol-loop skill documents.
// Nothing here calls a model or proves LLM routing quality. Run: node --test tools/skills.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
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
  "report-setup-issue": "Use when a reproducible defect or misleading output comes from the pi setup, its bundled tools, skills, guards, profiles or packages, rather than project code or user error.",
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
const reviewFiles = ["agent/workflows/review.js", ...["anthropic-heavy", "balanced", "balanced-anthropic", "balanced-openai", "kimi-heavy", "openai-heavy", "openai-only"].map(name => `agent/profiles/${name}/workflows/review.js`)];
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
async function runReview(args, { file = reviewFiles[0], override } = {}) {
  const calls = [];
  const models = modelMap(file);
  const agent = async (prompt, opts) => {
    calls.push(opts);
    assert.ok(!prompt.includes("runtimeStamp"));
    assert.ok(!prompt.includes("model-provenance/tool-call/v1"));
    assert.ok(!JSON.stringify(opts.schema).includes("runtimeProvenance"));
    const res = { summary: "ok", findings: [], verdicts: [], runtimeProvenance: provenance(models[opts.agentType], opts.label) };
    return override ? override(opts, res) : res;
  };
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item) => { let v = item; for (const s of stages) v = await s(v, item); return v; }));
  const fn = new AsyncFunction("args", "agent", "pipeline", "phase", "log", loadReview(file));
  const result = await fn(args, agent, pipeline, () => {}, () => {});
  return { result, calls: calls.length, requests: calls };
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
    const schemas = new Function(`${declarations.join(";\n")}; return { FINDINGS, VERDICTS };`)();
    for (const [name, schema] of Object.entries(schemas)) {
      const compiled = { schema, check: value => Check(schema, value) ? true : "schema mismatch" };
      const input = name === "FINDINGS" ? { summary: "ok", findings: [] } : { verdicts: [] };
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
    if (source.includes("const cacheKey")) assert.match(source, /const cacheKey = 'review-v2:'/);
  }
  for (const profile of ["balanced", "balanced-openai"]) assert.equal(loadReview(`agent/profiles/${profile}/workflows/review.js`), reviewSource);
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
    assert.equal(full.calls, 2);
    assert.equal(full.result.reviewers.length, 2);
    assert.ok(full.result.reviewers.every(run => run.ok && run.effective.length === 1 && run.session));
    const deep = await runReview({ ...base, deep: true, deepReason: "security", deepJustification: "auth change" }, { file, override: withClaims });
    assert.equal(deep.result.passed, true);
    assert.equal(deep.calls, 4);
    assert.equal(deep.result.reviewers.length, 4);
    const labels = deep.result.reviewers.map(run => run.label);
    assert.deepEqual(labels, [...labels].sort());
    for (const request of deep.requests) assert.equal(request.model, undefined, "no model overrides");
    const quick = await runReview({ ...base, quick: true }, { file });
    assert.equal(quick.calls, 1);
    assert.equal(quick.result.passed, true);
    assert.equal(quick.result.complete, true);
    assert.equal(quick.result.reviewers.length, 1);
  });

  test(`${file}: initial and mid-review fallback preserve four calls but cannot certify`, async () => {
    for (const when of ["before-first-response", "after-request-failure", "mid-review"]) {
      const run = await runReview(base, { file, override: (opts, res) => {
        withClaims(opts, res);
        if (opts.label.startsWith("review:")) withFallback(res,
          when === "before-first-response" ? ["kimi/moonshot-v1-128k"] : [...res.runtimeProvenance.models, "kimi/moonshot-v1-128k"], when);
        return res;
      } });
      assertUncertified(run.result);
      assert.equal(run.calls, 4, "no skipped verification or reruns");
      assert.equal(run.result.reviewers.length, 4);
      assert.equal(run.result.reviewers.filter(r => !r.ok).length, 2);
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
    assert.equal(run.calls, 4);
    assert.ok(run.result.incomplete.every(problem => problem.includes("verify:")));
  });

  test(`${file}: missing, forged-source, empty and unavailable records fail closed`, async () => {
    const invalid = [undefined, {}, { source: "self-reported", models: ["kimi/moonshot-v1-128k"] },
      { source: "model-provenance/v1", models: [] }, { source: "model-provenance/v1", models: [null] }];
    for (const p of invalid) {
      const run = await runReview(base, { file, override: (_opts, res) => ({ ...res, runtimeProvenance: p }) });
      assertUncertified(run.result);
      assert.equal(run.calls, 2);
      assert.ok(run.result.incomplete.every(problem => problem.endsWith("no runtime model record")));
    }
    const unavailable = await runReview(base, { file, override: (_opts, res) => {
      res.runtimeProvenance.unavailable = "runtime session records unavailable";
      return res;
    } });
    assertUncertified(unavailable.result);
  });

  test(`${file}: historical switches and request errors alone do not invalidate coverage`, async () => {
    const run = await runReview(base, { file, override: (_opts, res) => {
      res.runtimeProvenance.errors = 1;
      res.runtimeProvenance.initial = "kimi/moonshot-v1-128k";
      res.runtimeProvenance.switches = [{ from: "kimi/moonshot-v1-128k", to: res.runtimeProvenance.models[0], when: "before-first-response" }];
      return res;
    } });
    assert.equal(run.result.passed, true);
    assert.equal(run.calls, 2);
  });

  test(`${file}: quick-mode missing or different records cannot certify`, async () => {
    for (const override of [(_opts, res) => ({ ...res, runtimeProvenance: undefined }),
      (_opts, res) => withFallback(res, ["kimi/moonshot-v1-128k"])]) {
      const run = await runReview({ ...base, quick: true, force: true, allowFallback: true }, { file, override });
      assertUncertified(run.result);
      assert.equal(run.calls, 1);
    }
  });

  test(`${file}: failed review or verification follows existing failure paths`, async () => {
    const reviewFailed = await runReview(base, { file, override: () => null });
    assert.equal(reviewFailed.result.passed, false);
    assert.equal(reviewFailed.result.complete, false);
    assert.equal(reviewFailed.calls, 2);
    const verifyFailed = await runReview(base, { file, override: (opts, res) => opts.label.startsWith("review:") ? withClaims(opts, res) : null });
    assert.equal(verifyFailed.result.passed, false);
    assert.equal(verifyFailed.result.complete, false);
    assert.equal(verifyFailed.calls, 4);
  });
}

test("matching caches without complete reviewer evidence fail INCOMPLETE without rerunning", async () => {
  for (const file of reviewFiles.filter(file => loadReview(file).includes("const cacheKey"))) {
    const { result } = await runReview(base, { file, override: withClaims });
    assert.equal(result.reviewers.length, 4);
    const corruptions = [undefined, [], result.reviewers.slice(1), result.reviewers.filter(run => !run.label.startsWith("verify:")),
      result.reviewers.map(run => ({ ...run, effective: ["kimi/moonshot-v1-128k"], modelCounts: { "kimi/moonshot-v1-128k": run.assistants } })),
      result.reviewers.map(run => run.label.startsWith("verify:") ? { ...run, effective: ["kimi/moonshot-v1-128k"], modelCounts: { "kimi/moonshot-v1-128k": run.assistants } } : run),
      result.reviewers.map(run => ({ ...run, runtimeStamp: undefined }))];
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
  assert.match(result.reviewCacheKey, /^review-v2:/);
  const old = { ...result, reviewCacheKey: result.reviewCacheKey.replace("review-v2:", "review-v1:") };
  const run = await runReview({ ...base, cachedReview: old });
  assert.equal(run.calls, 2);
  assert.notEqual(run.result.cached, true);
});

test("fit preserves gate and coverage with six blockers and four reviewer records", async () => {
  const run = await runReview(base, { override: (opts, res) => {
    if (opts.label.startsWith("review:")) {
      res.summary = "summary ".repeat(100);
      res.findings = [0, 1, 2].map(i => ({ ...blockingClaim(i), problem: `regression ${i} ${"detail ".repeat(50)}` }));
    } else res.verdicts = [0, 1, 2].map(index => ({ index, status: "blocks", reason: "confirmed ".repeat(50) }));
    return res;
  } });
  assert.equal(run.result.passed, false);
  assert.equal(run.result.complete, true);
  assert.equal(run.result.blockingCount, 6);
  assert.equal(run.result.reviewers.length, 4);
  assert.ok(JSON.stringify(run.result).length < 3600);
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
