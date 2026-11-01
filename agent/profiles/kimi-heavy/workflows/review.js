/**
 * review.js — cross-provider review with adversarial verification.
 *
 * Full mode (default): Claude Opus 5.5 (`reviewer`) and GPT-6.1 Sol (`sol-reviewer`, high)
 * review independently; each one's findings are then checked by the OTHER provider,
 * which tries to refute them. Only findings that survive are reported as confirmed.
 * The Opus review runs at high effort (the reviewer agent defaults to medium);
 * verification runs at each agent's default effort.
 *
 * Deep mode (`deep: true`): the GPT side uses GPT-6 Astra (`second-opinion`, high) instead of
 * Sol, for both its review and its verification of Opus's findings. Reserve it for
 * security-sensitive, concurrency/algorithmic or large cross-cutting changes — it costs
 * considerably more OpenAI budget.
 *
 * Security lens (every mode): one extra reviewer from the provider that did NOT write the work reviews only
 * trust boundaries (caller-controlled input, authn/authz, tenancy, secure defaults, fail-closed, host parity,
 * injection, secrets). It returns nothing when the change touches no trust boundary. In full mode its blocking
 * findings are verified like the others; in quick mode they gate unverified (fail closed). Holes that already
 * existed in touched code come back as advisory items prefixed "PRE-EXISTING:" — track them (private advisory
 * for exploitable ones), never drop them. Added 2026-10-29 after GHSA-qr53-922q-xh7r slipped through review.
 *
 * Quick mode: one review by the provider that did NOT write the work, no verification:
 * GPT-6.1 Sol (`sol-reviewer`, high) for Claude-written work, Opus 5.5 (`reviewer`, medium)
 * for GPT-written work.
 *
 * args: {
 *   target:   string   — what to review, e.g. "the changes in `git diff main...HEAD`" or "src/auth/"
 *   context?: string   — intent/spec of the change, to judge it against
 *   author?:  "claude" | "gpt"  — who wrote the work; REQUIRED in quick mode, recommended in full mode.
 *                        `implementer` (Sol) output is "gpt"; Claude agents (general-purpose, careful-implementer,
 *                        opus-implementer, the main session) are "claude". In full mode with author "gpt", Opus's
 *                        findings are verified by GPT-6 Astra rather than by Sol, so Sol never adjudicates
 *                        findings against its own model's work.
 *   quick?:   boolean  — single cross-provider review, no verification (default false). Low-risk changes only;
 *                        use full mode for security-sensitive or mixed-authorship changes.
 *   deep?:    boolean  — full mode with GPT-6 Astra instead of GPT-6.1 Sol on the GPT side (default false).
 *                        Security-sensitive, algorithmic or large cross-cutting changes only.
 *   since?:   string   — follow-up round (requires prior and round): commit SHA the previous review saw.
 *                        Only after a whole-change review in the same mode. Reviewers then look only at
 *                        `git diff <since>..HEAD` (the fixes) and whether `prior` findings are resolved.
 *   prior?:   string   — the previous round's blocking findings (and any you dismissed, with the reason),
 *                        so reviewers check those instead of hunting for new edge cases in unchanged code.
 *   round?:   number   — review round for this work item (1 = first). Rounds above 3 are refused unless
 *                        force: true — at that point make a structural fix or ask the user.
 *   force?:   boolean  — override the round cap.
 * }
 *
 * Gate: only BLOCKING findings fail a review — critical/major issues a maintainer would block merge on
 * (regression, data loss, security, spec violation, broken build/tests), confirmed by the other provider
 * (full mode). Minor issues and nits come back in `advisory`: fix them in the same pass if cheap, never
 * start another review round for them.
 *
 * Result: every return carries `passed` (boolean). It is true only when the review completed
 * (every reviewer and verifier returned) and no blocking finding is confirmed or unverified,
 * and every reviewer's runtime-recorded model (child session records, via model-provenance)
 * equals the agent's configured model. Fallback or missing records make it incomplete: no retry, no override.
 * The result is kept compact (blocking findings in full, advisory as one-liners) so the parent's
 * notification is not truncated. A failed,
 * missing or incomplete review is never a pass — gate merges on `passed === true`, not on an
 * empty `confirmed` list.
 *
 * Run: "run the review workflow on the changes in git diff main...HEAD"
 */
export const meta = {
  name: 'review',
  description: 'Cross-provider code/work review (Opus 5.5 + GPT-6.1 Sol; GPT-6 Astra with deep: true); only blocking findings gate, verified by the other provider',
  whenToUse: 'Reviewing a diff, a change set, a document or a plan before it is merged or published',
  phases: [
    { title: 'Review', detail: 'Opus 5.5 and GPT-6.1 Sol (Astra in deep mode) review independently, plus a cross-provider security lens' },
    { title: 'Verify', detail: 'each finding is challenged by the other provider' },
  ],
}

// The SubagentWorkflow tool can deliver args as a JSON string rather than an object.
const input = typeof args === "string" ? JSON.parse(args) : args

const target = input?.target
if (!target) {
  return { passed: false, error: 'Missing args.target — say what to review (a diff range, paths, or a document).' }
}
const context = input?.context ? `\n\nIntent / spec of the work:\n${input.context}` : ''
const quick = input?.quick === true
if (quick && input?.author !== 'claude' && input?.author !== 'gpt') {
  return { passed: false, error: 'Quick mode needs args.author: "claude" or "gpt" (who wrote the work), so the review goes to the other provider.' }
}
const author = input?.author === 'gpt' ? 'gpt' : 'claude'
const deep = input?.deep === true
if (quick && deep) {
  return { passed: false, error: 'quick and deep cannot be combined — deep is a full review with GPT-6 Astra.' }
}

const since = typeof input?.since === 'string' && input.since.trim() ? input.since.trim() : null
const prior = typeof input?.prior === 'string' && input.prior.trim() ? input.prior.trim() : null
if (input?.round !== undefined && !(Number.isInteger(input.round) && input.round >= 1)) {
  return { passed: false, error: `round must be a positive integer, got ${JSON.stringify(input.round)}.` }
}
if ((since || prior) && input?.round === undefined) {
  return { passed: false, error: 'Follow-up reviews (since/prior) must pass an explicit round (2 or 3).' }
}
if (since && !prior) {
  return {
    passed: false,
    error: 'since needs prior: pass the previous round\'s blocking findings (and any dismissed, with the reason) ' +
      'so unresolved issues in unchanged code are still checked.',
  }
}
const round = input?.round ?? 1
if (round > 3 && input?.force !== true) {
  return {
    passed: false,
    error: `Round ${round} refused: the review cap is 3 rounds per work item. Findings that keep coming back mean ` +
      'the approach needs a structural fix (sweep the whole class of issue) or a decision from the user. ' +
      'Pass force: true only after one of those.',
  }
}

// Pinned models, not provider labels. Keep synchronized with agent frontmatter.
const AGENT_MODELS = {
  reviewer: 'anthropic/claude-opus-5-5',
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
  // Transitional (pi-setup#87): a parent session started before model-provenance was installed stamps no record at all.
  // An absent record is reported, not blocking; a present record that is unavailable, malformed or mismatched still blocks.
  const absent = p === undefined || p === null
  const ok = absent || (available && models.every(model => model === expected))
  if (absent) runtimeRuns.push({ label: opts.label, agentType: opts.agentType, expected, effective: [], ok, provenance: 'unavailable (pre-update session)' })
  else {
    if (!available) runtimeProblems.push(`${name} (${opts.label}): no runtime model record`)
    else if (!ok) runtimeProblems.push(`${name} (${opts.label}) ran on ${models.join(', ')}, not ${expected} (${classification(p)})`)
    runtimeRuns.push({ ...runtimeDetails(p), label: opts.label, agentType: opts.agentType, expected, effective: models, ok })
  }
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
    summary: { type: 'string', description: 'Two or three sentences: overall assessment.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          blocking: {
            type: 'boolean',
            description: 'true only if a maintainer would refuse to merge until this is fixed: regression, data loss, ' +
              'security hole, spec/acceptance violation, broken build or tests. Never true for minor or nit.',
          },
          location: { type: 'string', description: 'file:line or section' },
          problem: { type: 'string' },
          fix: { type: 'string' },
          verified: { type: 'boolean', description: 'true only if you confirmed it by reading the code or running a check' },
        },
        required: ['severity', 'blocking', 'location', 'problem', 'fix', 'verified'],
      },
    },
  },
  required: ['summary', 'findings'],
}

const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          status: {
            type: 'string',
            enum: ['blocks', 'not-blocking', 'refuted', 'uncertain'],
            description: 'blocks = real and merge-blocking; not-blocking = real but minor/pre-existing/hypothetical; ' +
              'refuted = you positively showed it is wrong; uncertain = you could not confirm or refute it.',
          },
          reason: { type: 'string' },
        },
        required: ['index', 'status', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const REVIEWERS = {
  claude: { agentType: 'reviewer', name: 'Opus 5.5', reviewEffort: 'high' },
  gpt: deep
    ? { agentType: 'second-opinion', name: 'GPT-6 Astra' }
    : { agentType: 'sol-reviewer', name: 'GPT-6.1 Sol' },
}
const QUICK_REVIEWERS = {
  claude: { agentType: 'reviewer', name: 'Opus 5.5' },
  gpt: { agentType: 'sol-reviewer', name: 'GPT-6.1 Sol' },
}
const other = side => (side === 'claude' ? 'gpt' : 'claude')
const ASTRA = { agentType: 'second-opinion', name: 'GPT-6 Astra' }
// Who checks the findings reported by `side`. Sol must not judge findings against Sol-written work.
const verifierFor = side =>
  side === 'claude' && author === 'gpt' && !deep ? ASTRA : REVIEWERS[other(side)]

const scope = since
  ? `\n\nThis is follow-up round ${round}. Review ONLY the changes in \`git diff ${since}..HEAD\` (the fixes since the ` +
    'last review) and whether the earlier findings below are resolved. Do not re-review unchanged code or hunt for ' +
    'new edge cases in it; raise something outside the fix delta only if it is a critical defect.'
  : ''
const priorText = prior
  ? `\n\nEarlier findings / decisions (check whether each is resolved; do not re-raise items marked dismissed):\n${prior}`
  : ''
const RUBRIC =
  '\n\nSeverity and blocking rubric:\n' +
  '- blocking=true (critical/major only): regression, data loss, security hole, spec or acceptance violation, ' +
  'broken build/tests, behaviour changed outside the requested scope.\n' +
  '- minor: real but non-blocking (missing test for a secondary path, unclear naming, small inefficiency).\n' +
  '- nit: style, wording, preference.\n' +
  'Do NOT report: defects that existed before this change (mention at most one in the summary), hypothetical inputs ' +
  'unreachable from the spec or callers, wording-only doc/comment points, PR descriptions or release notes ' +
  '(deterministic hooks check those). Prefer a few material findings over an exhaustive list.'

const reviewPrompt =
  `Review ${target}.${context}${scope}${priorText}\n\n` +
  'Look for correctness problems, regressions, behaviour changed outside the requested scope, ' +
  'missing or broken tests and security issues. Read the actual code; do not guess. ' +
  'Report only real problems — an empty findings list is a valid answer.' + RUBRIC

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

const isBlocking = f => f.blocking === true && (f.severity === 'critical' || f.severity === 'major')
const clip = (t, n) => (typeof t === 'string' && t.length > n ? t.slice(0, n) + '…' : t)
const oneLine = f => clip(`(${f.severity}) ${f.location}: ${f.problem}`, 160)
// Security holes found in touched code that predate the change: surfaced separately so they are never lost
// in the advisory list. The caller tracks them (private advisory for exploitable ones).
const preExisting = list => list.filter(f => typeof f.problem === 'string' && f.problem.startsWith('PRE-EXISTING:')).slice(0, 5).map(oneLine)
const full = f => ({
  severity: f.severity, location: clip(f.location, 120), problem: clip(f.problem, 300), fix: clip(f.fix, 160),
  ...(f.foundBy ? { foundBy: f.foundBy } : {}), ...(f.note ? { note: clip(f.note, 160) } : {}),
})
// Keep the serialized result under the parent notification limit (~4000 chars) without ever dropping
// gate status or the count of blockers: shrink detail step by step, then fall back to one-liners and counts.
const fit = (res, budget = 3600) => {
  const size = () => JSON.stringify(res).length
  if (size() <= budget) return res
  trimRuntimeDetails(res)
  res.advisory = res.advisory ? res.advisory.slice(0, 3).concat(res.advisory.length > 3 ? [`…${res.advisory.length - 3} more`] : []) : res.advisory
  if (res.summaries) res.summaries = res.summaries.map(s => ({ by: s.by, summary: clip(s.summary, 150) }))
  if (size() <= budget) return res
  for (const key of ['blocking', 'unverified']) if (Array.isArray(res[key])) res[key] = res[key].map(f => oneLine(f))
  if (size() <= budget) return res
  for (const key of ['blocking', 'unverified']) {
    if (Array.isArray(res[key]) && res[key].length > 6) {
      const n = res[key].length
      res[key] = res[key].slice(0, 6).concat([`…${n - 6} more (rerun or ask the reviewer for the rest)`])
    }
  }
  res.advisory = Array.isArray(res.advisory) ? [`${res.advisory.length} advisory items omitted for size`] : res.advisory
  compactRuntimeRuns(res, size() > budget)
  return res
}
const ADVISORY_MAX = 10
const advisoryList = list => {
  const out = list.slice(0, ADVISORY_MAX).map(oneLine)
  if (list.length > ADVISORY_MAX) out.push(`…and ${list.length - ADVISORY_MAX} more`)
  return out
}
const nextStep = passed =>
  passed
    ? 'Passed. Fix cheap advisory items in the same change if you like; do not start another review round for them.'
    : round >= 3
      ? 'Not passed at the round cap. Make a structural fix for the whole class of issue or ask the user; do not loop.'
      : `Fix the blocking findings, commit, then rerun with since: <HEAD sha reviewed now>, prior: <blocking list>, round: ${round + 1}.`

phase('Review')

if (quick) {
  const side = other(author)
  const r = QUICK_REVIEWERS[side]
  const [res, sec] = await parallel([
    () => reviewAgent(reviewPrompt, { agentType: r.agentType, schema: FINDINGS, label: `review:${side}`, phase: 'Review' }, r.name),
    () => reviewAgent(securityPrompt, { agentType: r.agentType, schema: FINDINGS, label: `review:security-${side}`, phase: 'Review' }, `${r.name} (security)`),
  ])
  if (!res) return { mode: 'quick', round, passed: false, error: `${r.name} review failed` }
  if (!sec) return { mode: 'quick', round, passed: false, error: `${r.name} security review failed` }
  // Quick mode has no verifier: security blockers gate unverified (fail closed).
  const all = res.findings.concat(sec.findings.map(f => ({ ...f, foundBy: `${r.name} (security)` })))
  const blocking = all.filter(isBlocking)
  const incomplete = [...runtimeProblems]
  const passedQ = blocking.length === 0 && incomplete.length === 0
  return fit({
    mode: 'quick', round, passed: passedQ, complete: incomplete.length === 0, incomplete,
    reviewers: runtimeReviewers(), reviewedBy: r.name, blockingCount: blocking.length,
    summary: clip(res.summary, 400), securitySummary: clip(sec.summary, 300),
    blocking: blocking.map(full), preExistingSecurity: preExisting(all), advisory: advisoryList(all.filter(f => !isBlocking(f))),
    next: runtimeProblems.length ? runtimeNext : nextStep(passedQ),
  })
}

// The security lens runs on the provider that did NOT write the work and is verified by the other provider.
const secSide = other(author)
const LANES = [
  { key: 'claude', side: 'claude', reviewer: REVIEWERS.claude, prompt: reviewPrompt },
  { key: 'gpt', side: 'gpt', reviewer: REVIEWERS.gpt, prompt: reviewPrompt },
  { key: `security-${secSide}`, side: secSide, reviewer: { ...REVIEWERS[secSide], name: `${REVIEWERS[secSide].name} (security)` }, prompt: securityPrompt },
]
const results = await pipeline(
  LANES,
  lane =>
    reviewAgent(lane.prompt, {
      agentType: lane.reviewer.agentType,
      schema: FINDINGS,
      label: `review:${lane.key}`,
      phase: 'Review',
      ...(lane.reviewer.reviewEffort ? { effort: lane.reviewer.reviewEffort } : {}),
    }, lane.reviewer.name),
  async (res, lane) => {
    const side = lane.side
    if (!res) return { lane, side, failed: true }
    // Only blocking claims are adversarially verified; everything else is advisory and never gates.
    const toCheck = res.findings.map((f, i) => ({ f, i })).filter(x => isBlocking(x.f))
    if (toCheck.length === 0) return { lane, side, summary: res.summary, findings: res.findings, verdicts: [] }
    const verifier = other(side)
    const checkerAgent = verifierFor(side)
    const list = toCheck
      .map(({ f, i }) => `[${i}] (${f.severity}) ${f.location}: ${f.problem}\n    Suggested fix: ${f.fix}`)
      .join('\n')
    const v = await reviewAgent(
      `Another model (${lane.reviewer.name}) reviewed ${target} and reported the findings below.${context}\n\n` +
        'Each was claimed to BLOCK merge. Independently check each one against the actual code. Try to refute it. ' +
        'status: "refuted" only if you positively showed the claim is wrong (cite the code); "uncertain" if you ' +
        'could not confirm or refute it (e.g. could not access or run the relevant code); "blocks" if it is real ' +
        'AND a maintainer would refuse to merge until it is fixed (regression, data loss, security, spec violation, ' +
        'broken build/tests); "not-blocking" if it is real but minor, pre-existing or hypothetical. ' +
        'Return one verdict per index.' + scope + '\n\n' +
        list,
      { agentType: checkerAgent.agentType, schema: VERDICTS, label: `verify:${lane.key}-by-${verifier}`, phase: 'Verify' },
      checkerAgent.name,
    )
    return { lane, side, summary: res.summary, findings: res.findings, verdicts: v ? v.verdicts : null }
  },
)

const confirmed = []
const rejected = []
const unverified = []
const advisory = []
const summaries = []
const incomplete = []

// A pipeline item that threw comes back as null; treat it as a failed review, never skip it.
results.forEach((r, i) => {
  if (!r) incomplete.push(`${LANES[i].reviewer.name} review did not complete`)
})

for (const r of results.filter(Boolean)) {
  const by = r.lane.reviewer.name
  if (r.failed) {
    log(`${by} review failed`)
    summaries.push({ by, summary: 'REVIEW FAILED' })
    incomplete.push(`${by} review failed`)
    continue
  }
  if (r.findings.some(isBlocking) && !r.verdicts) incomplete.push(`verification of ${by}'s findings failed`)
  summaries.push({ by, summary: clip(r.summary, 400) })
  const checker = verifierFor(r.side).name
  r.findings.forEach((f, i) => {
    const item = { ...f, foundBy: by }
    if (!isBlocking(f)) return advisory.push(item)
    const verdict = r.verdicts ? r.verdicts.find(v => v.index === i) : null
    // Fail closed: anything not positively refuted or positively downgraded keeps blocking.
    if (!verdict || verdict.status === 'uncertain' || !['blocks', 'not-blocking', 'refuted'].includes(verdict.status))
      unverified.push({ ...item, note: verdict ? verdict.reason : 'no verdict' })
    else if (verdict.status === 'blocks') confirmed.push({ ...item, confirmedBy: checker, note: verdict.reason })
    else if (verdict.status === 'not-blocking') advisory.push({ ...item, severity: 'minor', downgradedBy: checker })
    else rejected.push({ ...item, rejectedBy: checker, reason: verdict.reason })
  })
}

const order = { critical: 0, major: 1, minor: 2, nit: 3 }
confirmed.sort((a, b) => order[a.severity] - order[b.severity])
advisory.sort((a, b) => order[a.severity] - order[b.severity])
incomplete.push(...runtimeProblems)
const complete = incomplete.length === 0
const passed = complete && confirmed.length === 0 && unverified.length === 0
log(`${confirmed.length} blocking, ${advisory.length} advisory, ${rejected.length} rejected, ${unverified.length} unverified — ${passed ? 'PASSED' : 'NOT PASSED'}`)
if (!complete) log(`Incomplete: ${incomplete.join('; ')}`)

return fit({
  mode: deep ? 'deep' : 'full',
  round,
  passed,
  complete,
  incomplete,
  reviewers: runtimeReviewers(),
  blockingCount: confirmed.length,
  unverifiedCount: unverified.length,
  target: clip(target, 160),
  summaries,
  blocking: confirmed.map(full),
  unverified: unverified.map(full),
  advisory: advisoryList(advisory),
  preExistingSecurity: preExisting(advisory),
  rejected: rejected.map(f => clip(`${f.location}: ${f.problem} — refuted: ${f.reason}`, 160)).slice(0, 3),
  rejectedCount: rejected.length,
  next: runtimeProblems.length ? runtimeNext : nextStep(passed),
})
