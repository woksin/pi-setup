export const meta = {
  name: 'review',
  description: 'OpenAI-only independent Sol/Astra review with adversarial cross-model verification',
  whenToUse: 'Review a whole change before merge; quick mode for iteration, deep mode for hard reasoning',
  phases: [
    { title: 'Review', detail: 'Sol and Astra review independently, plus a cross-model security lens' },
    { title: 'Verify', detail: 'the other OpenAI model challenges blocking findings' },
  ],
}

// Cross-model, NOT cross-provider. All named agents are pinned to openai-codex.
// args: target (required), context, author (sol/astra; legacy gpt/claude accepted),
// quick, deep, since, prior, round (1..3), force. Quick mode requires author;
// legacy gpt/claude authors use Astra. Full mode always uses both models.
// Delta reviews require an earlier whole-change review in the same mode and prior findings.
// Security lens (every mode): one extra reviewer from the model that did NOT write the work (same choice as quick
// mode: author astra -> Sol, otherwise Astra) reviews only trust boundaries (caller-controlled input, authn/authz,
// tenancy, secure defaults, fail-closed, host parity, injection, secrets). It returns nothing when the change touches
// no trust boundary. In full mode its blocking findings are verified by the other model; in quick mode they gate
// unverified (fail closed). Holes that already existed in touched code come back as advisory items prefixed
// "PRE-EXISTING:" — track them (private advisory for exploitable ones), never drop them.
const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
const target = input.target
if (typeof target !== 'string' || !target.trim()) return { passed: false, error: 'Missing args.target.' }
const quick = input.quick === true
const deep = input.deep === true
if (quick && deep) return { passed: false, error: 'quick and deep cannot be combined.' }
if (quick && !['sol', 'astra', 'gpt', 'claude'].includes(input.author)) {
  return { passed: false, error: 'Quick review requires author: sol or astra (legacy gpt/claude accepted).' }
}
const since = typeof input.since === 'string' && input.since.trim() ? input.since.trim() : null
const prior = typeof input.prior === 'string' && input.prior.trim() ? input.prior.trim() : null
if (input.round !== undefined && !(Number.isInteger(input.round) && input.round >= 1)) {
  return { passed: false, error: 'round must be a positive integer.' }
}
const round = input.round ?? 1
if ((since || prior) && (input.round === undefined || round < 2)) {
  return { passed: false, error: 'Follow-up reviews require an explicit round of 2 or higher.' }
}
if (since && !prior) return { passed: false, error: 'since requires prior findings and dismissal reasons.' }
if (round > 3 && input.force !== true) {
  return { passed: false, error: 'Three-round cap reached. Make a structural fix or ask the user.' }
}
// Complete only when every runtime-recorded model matches its configured agent; no retry or override.
// Pinned models, not provider labels. Keep synchronized with agent frontmatter.
const AGENT_MODELS = {
  reviewer: 'openai-codex/gpt-6-astra',
  'sol-reviewer': 'openai-codex/gpt-6.1-sol',
  'second-opinion': 'openai-codex/gpt-6-astra',
}
const runtimeRuns = []
const runtimeProblems = []
// Never included in reviewer schemas/prompts; accidental imitation defense, NOT authentication.
const RUNTIME_STAMP = 'model-provenance/tool-call/v1'
const runtimeNext = 'Not certified: a reviewer ran on a different model than configured (see incomplete). Do not rerun or override; report it to the user/routing owner.'
const classification = p => ({
  'before-first-response': 'provider fallback before its first response',
  'after-request-failure': 'provider fallback after a failed request',
})[p?.switches?.[0]?.when] ?? 'model switched during the review'
const runtimeModels = p => {
  if (!Array.isArray(p?.models)) return []
  return p.models.every(model => typeof model === 'string' && model.length > 0) ? p.models : []
}
const positiveInteger = value => Number.isInteger(value) && value > 0
const countMap = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const runtimeCounts = (p, models) => {
  if (!countMap(p?.modelCounts)) return false
  const counts = p.modelCounts
  if (models.length === 0) return false
  if (Object.keys(counts).length !== models.length) return false
  if (new Set(models).size !== models.length) return false
  if (!models.every(model => positiveInteger(counts[model]))) return false
  return models.reduce((total, model) => total + counts[model], 0) === p.assistants
}
const runtimeSource = p => p?.source === 'model-provenance/v1' && p.runtimeStamp === RUNTIME_STAMP && p.unavailable === undefined && Array.isArray(p.switches)
const nonemptyText = value => typeof value === 'string' && value.trim().length > 0
const runtimeIdentity = p => nonemptyText(p?.session) && nonemptyText(p.agent) && nonemptyText(p.initial)
const runtimeTotals = p => positiveInteger(p?.assistants) && Number.isInteger(p.errors) && p.errors >= 0 && p.errors <= p.assistants
const runtimeTimestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value))
const runtimeWindow = p => runtimeTimestamp(p?.firstAt) && runtimeTimestamp(p.lastAt) && Date.parse(p.firstAt) <= Date.parse(p.lastAt)
const runtimeAvailable = (p, models) => runtimeSource(p) && runtimeIdentity(p) && runtimeTotals(p) && runtimeWindow(p) && runtimeCounts(p, models)
const runtimeDetails = p => {
  if (!p) return {}
  const { source, runtimeStamp, initial, agent, session, firstAt, lastAt, switches, errors, assistants, modelCounts } = p
  return { source, runtimeStamp, initial, agent, session, firstAt, lastAt, switches, errors, assistants, modelCounts }
}
const record = (res, opts, name) => {
  const p = res.runtimeProvenance
  const expected = AGENT_MODELS[opts.agentType]
  const models = runtimeModels(p)
  const available = runtimeAvailable(p, models)
  const ok = available && models.every(model => model === expected)
  if (!available) runtimeProblems.push(`${name} (${opts.label}): no runtime model record`)
  else if (!ok) runtimeProblems.push(`${name} (${opts.label}) ran on ${models.join(', ')}, not ${expected} (${classification(p)})`)
  runtimeRuns.push({ ...runtimeDetails(p), label: opts.label, agentType: opts.agentType, expected, effective: models, ok })
}
const reviewAgent = async (prompt, opts, name) => {
  const res = await agent(prompt, opts)
  if (res) record(res, opts, name)
  return res
}
const runtimeReviewers = () => runtimeRuns.sort((a, b) => a.label.localeCompare(b.label))
const trimRuntimeDetails = res => {
  if (!res.reviewers) return
  res.reviewers = res.reviewers.map(({ switches, ...run }) => run.ok ? run : { ...run, switches })
}
const compactRuntimeRuns = (res, oversized) => {
  if (!oversized || !res.reviewers) return
  res.reviewers = res.reviewers.map(run =>
    `${run.label}: ${run.effective.join(', ') || 'no runtime model record'}; expected ${run.expected}; ${run.ok ? 'ok' : 'INCOMPLETE'}`)
}
// End runtime recording.

const FINDINGS = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array', items: {
        type: 'object', properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          blocking: { type: 'boolean' },
          location: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' },
          verified: { type: 'boolean' },
        }, required: ['severity', 'blocking', 'location', 'problem', 'fix', 'verified'],
      },
    },
  }, required: ['summary', 'findings'],
}
const VERDICTS = {
  type: 'object', properties: {
    verdicts: {
      type: 'array', items: {
        type: 'object', properties: {
          index: { type: 'integer' },
          status: { type: 'string', enum: ['blocks', 'not-blocking', 'refuted', 'uncertain'] },
          reason: { type: 'string' },
        }, required: ['index', 'status', 'reason'],
      },
    },
  }, required: ['verdicts'],
}
const reviewers = {
  sol: { agentType: 'sol-reviewer', name: 'GPT-6.1 Sol', effort: 'high' },
  astra: { agentType: deep ? 'second-opinion' : 'reviewer', name: 'GPT-6 Astra', effort: deep ? 'xhigh' : 'high' },
}
const other = side => side === 'sol' ? 'astra' : 'sol'
const blocking = f => f.blocking === true && ['critical', 'major'].includes(f.severity)
const context = input.context ? `\nIntent/spec:\n${input.context}` : ''
const scope = since ? `\nFollow-up round ${round}: review ONLY git diff ${since}..HEAD and resolution of prior findings. Do not hunt for new defects in unchanged code except critical defects.` : ''
const priorText = prior ? `\nEarlier findings/decisions (respect dismissals):\n${prior}` : ''
const rubric = '\nOnly critical/major regressions, data loss, security holes, spec violations, broken builds/tests or out-of-scope behaviour changes block merge. Minor/nit items are advisory. Exclude pre-existing defects, unreachable hypothetical inputs, wording preferences and release notes/PR descriptions. Read actual code; do not guess. Remain read-only and obey execution budgets. Empty findings are valid.'
const prompt = `Review ${target}.${context}${scope}${priorText}\nCheck correctness, regressions, security and missing/broken tests.${rubric}`
const securityPrompt =
  `Security review of ${target}.${context}${scope}${priorText}\n\n` +
  'You are the SECURITY lens. Ignore general correctness, style and performance; other reviewers cover those. ' +
  'First decide whether the change touches a trust boundary: request handling (endpoints, headers, query, cookies, ' +
  'route values, body fields), authentication, authorization, roles/policies, tenancy, identity, validation that ' +
  'enforces business, state or ownership rules, secrets/credentials/tokens, (de)serialization, file/path/process/SQL/' +
  'shell handling, outbound network calls, cryptography, logging of sensitive data, generated clients/proxies, or ' +
  'security-relevant configuration defaults. If it touches none, return an empty findings list and say so in one line.\n' +
  'Otherwise read the real code paths end to end and check:\n' +
  '- Caller-controlled input: can any value a caller sends (header, query, cookie, body field, client-side flag) weaken ' +
  'validation, authorization, tenant or identity checks, or select a less strict code path? Server-side enforcement must ' +
  'never depend on the client (generated proxies, UI components) behaving well.\n' +
  '- Secure by default: relaxing a security or validation rule must be an explicit server-side opt-in (attribute, ' +
  'option), never the default and never caller-selected. A documentation warning is not a mitigation.\n' +
  '- Anonymous and low-privilege callers: what can public/[AllowAnonymous] endpoints and callers holding only the ' +
  'required role reach? Ownership, tenant and organization rules must still hold for them.\n' +
  '- Fail closed: errors, missing configuration, unknown enum values and parse failures must deny, not allow.\n' +
  '- Parity: every host, transport and language variant of the same behaviour (HTTP, MCP, gRPC, C#/Kotlin/TypeScript) ' +
  'enforces the same rule.\n' +
  '- Injection and unsafe handling: SQL, shell, path traversal, templates, unsafe deserialization, SSRF, open redirects.\n' +
  '- Exposure: credentials, tokens, connection strings or personal data in logs, errors, responses or telemetry; ' +
  'unsigned or unvalidated cookies/tokens treated as identity.\n' +
  '- Tests: a security rule that is added or changed needs a spec proving the hostile case is rejected.\n\n' +
  'For each finding, put a concrete exploit sketch in problem (who sends what, and what happens). blocking=true ' +
  '(critical/major) for any exploitable hole this change introduces or widens, including a missing hostile-case spec ' +
  'for a new security rule. A hole that already existed in code this change touches: report it with severity major, ' +
  'blocking=false, and start problem with "PRE-EXISTING:" so it is tracked; do not omit it. Do not report theoretical ' +
  'issues without a reachable path. ' +
  'Deployment context: in Cratis repositories, assume the Cratis platform deployment (services behind Cratis AuthProxy, ' +
  'which strips client identity and tenant headers and injects verified ones). Rate a hole that AuthProxy fully ' +
  'neutralises as minor and say so; holes AuthProxy passes through (other headers, bodies, responses, authenticated ' +
  'callers) keep their full severity. An empty findings list is a valid answer.'
const call = (side, text, schema, label, phaseName) => reviewAgent(text, {
  agentType: reviewers[side].agentType, effort: reviewers[side].effort,
  schema, label, phase: phaseName,
}, reviewers[side].name)
const advisoryText = f => `(${f.severity}) ${f.location}: ${f.problem}`
// Security holes found in touched code that predate the change: surfaced separately so they are never lost
// in the advisory list. The caller tracks them (private advisory for exploitable ones).
const preExisting = list => list.filter(f => typeof f.problem === 'string' && f.problem.startsWith('PRE-EXISTING:')).slice(0, 5).map(advisoryText)
// The security lens runs on the model that did NOT write the work (same rule as quick mode).
const secSide = input.author === 'astra' ? 'sol' : 'astra'
const next = passed => passed ? 'Passed; fix cheap advisory items in the same pass, not another round.'
  : round >= 3 ? 'Not passed at the cap; make a structural fix or ask the user.'
    : `Fix blockers and rerun with since, prior and round: ${round + 1}.`
phase('Review')
if (quick) {
  const side = input.author === 'astra' ? 'sol' : 'astra'
  const [res, sec] = await parallel([
    () => call(side, prompt, FINDINGS, `review:${side}`, 'Review'),
    () => call(side, securityPrompt, FINDINGS, `review:security-${side}`, 'Review'),
  ])
  if (!res) return { passed: false, mode: 'quick', error: 'Review failed.' }
  if (!sec) return { passed: false, mode: 'quick', error: 'Security review failed.' }
  // Quick mode has no verifier: security blockers gate unverified (fail closed).
  const all = res.findings.concat(sec.findings.map(f => ({ ...f, foundBy: `${reviewers[side].name} (security)` })))
  const blockers = all.filter(blocking)
  const incomplete = [...runtimeProblems]
  const passedQ = blockers.length === 0 && incomplete.length === 0
  return {
    mode: 'quick', round, passed: passedQ, complete: incomplete.length === 0, incomplete,
    reviewers: runtimeReviewers(), reviewedBy: reviewers[side].name,
    diversity: 'OpenAI-only cross-model', summary: res.summary, securitySummary: sec.summary,
    blockingCount: blockers.length, blocking: blockers, preExistingSecurity: preExisting(all),
    advisory: all.filter(f => !blocking(f)).map(advisoryText), next: runtimeProblems.length ? runtimeNext : next(passedQ),
  }
}
// The security lens is verified by the other model, like any other lane.
const lanes = [
  { key: 'sol', side: 'sol', name: reviewers.sol.name, prompt },
  { key: 'astra', side: 'astra', name: reviewers.astra.name, prompt },
  { key: `security-${secSide}`, side: secSide, name: `${reviewers[secSide].name} (security)`, prompt: securityPrompt },
]
const results = await pipeline(lanes,
  lane => call(lane.side, lane.prompt, FINDINGS, `review:${lane.key}`, 'Review'),
  async (res, lane) => {
    const side = lane.side
    if (!res) return { lane, side, failed: true }
    const claims = res.findings.map((f, index) => ({ ...f, index })).filter(blocking)
    if (!claims.length) return { lane, side, ...res, verdicts: [] }
    const checker = other(side)
    const verified = await call(checker,
      `Try to REFUTE each blocking claim from ${lane.name} about ${target}.${context}${scope}${priorText}\n` +
      'Read the actual code independently. Return exactly one verdict per index: blocks if real and merge-blocking; not-blocking if real but minor, pre-existing or hypothetical; refuted only with positive evidence; uncertain if inaccessible or unresolved. Cite evidence in reason. Do not edit files.\n' +
      JSON.stringify(claims) + rubric,
      VERDICTS, `verify:${lane.key}-by-${checker}`, 'Verify')
    return { lane, side, ...res, verdicts: verified ? verified.verdicts : null }
  },
)
const confirmed = [], unverified = [], advisory = [], rejected = [], incomplete = [], summaries = []
results.forEach((res, index) => {
  const side = lanes[index].side
  const by = lanes[index].name
  if (!res || res.failed) { incomplete.push(`${by} review failed`); return }
  summaries.push({ by, summary: res.summary })
  if (res.findings.some(blocking) && !res.verdicts) incomplete.push(`${by} verification failed`)
  res.findings.forEach((f, i) => {
    const item = { ...f, foundBy: by }
    if (!blocking(f)) { advisory.push(item); return }
    const matches = (res.verdicts || []).filter(v => v.index === i)
    const verdict = matches.length === 1 ? matches[0] : null
    if (!verdict || verdict.status === 'uncertain' || !['blocks', 'not-blocking', 'refuted'].includes(verdict.status)) {
      unverified.push({ ...item, note: verdict?.reason || 'Missing, duplicate or invalid verdict' })
    } else if (verdict.status === 'blocks') {
      confirmed.push({ ...item, confirmedBy: reviewers[other(side)].name, note: verdict.reason })
    } else if (verdict.status === 'not-blocking') advisory.push({ ...item, severity: 'minor' })
    else rejected.push({ ...item, reason: verdict.reason })
  })
})
incomplete.push(...runtimeProblems)
const passed = !incomplete.length && !confirmed.length && !unverified.length
log(`${confirmed.length} blocking, ${unverified.length} unverified, ${advisory.length} advisory — ${passed ? 'PASSED' : 'NOT PASSED'}`)
return {
  mode: deep ? 'deep' : 'full', diversity: 'OpenAI-only cross-model', round, target, passed,
  complete: incomplete.length === 0, incomplete, summaries, reviewers: runtimeReviewers(),
  blockingCount: confirmed.length, unverifiedCount: unverified.length,
  blocking: confirmed, unverified, advisory: advisory.map(advisoryText), preExistingSecurity: preExisting(advisory),
  rejectedCount: rejected.length, rejected: rejected.map(f => `${f.location}: ${f.reason}`), next: runtimeProblems.length ? runtimeNext : next(passed),
}
