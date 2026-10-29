/**
 * review.js — cross-provider review with adversarial verification.
 * Enforces all argument/round/deep-mode rules before spending reviewer tokens,
 * and reuses caller-carried full passing verdicts for identical committed scope.
 *
 * Full mode (default): Claude Opus 5.5 (`reviewer`) and GPT-6.1 Sol (`sol-reviewer`, high)
 * review independently; each one's findings are then checked by the OTHER provider,
 * which tries to refute them. Only findings that survive are reported as confirmed.
 * The Opus review runs at the reviewer agent's medium effort (Opus 5.5 medium >= xhigh, Oct 2026);
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
 *   round:    number   — review round for this work item (1 = first). Rounds above 3 are refused unless
 *                        force: true — at that point make a structural fix or ask the user.
 *   force?:   boolean  — override the round cap.
 *   deepReason?: "security" | "algorithmic" | "concurrency" | "cross-cutting"
 *   deepJustification?: string — required one-line justification when deep is true.
 *   headSha?: string — full HEAD SHA for cache reuse (sandbox has no git/fs access).
 *   baseSha?: string — full base SHA; required to use caller-carried cachedReview.
 *   cachedReview?: object — previous full result, unchanged; see INSTALL.md for cache limitations.
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
  description: 'Two-model code/work review on Anthropic models (Opus 5.5 + Sonnet 5.5; Opus 5.5 high with deep: true); only blocking findings gate, verified by the other model',
  whenToUse: 'Reviewing a diff, change set, document or plan before it is merged or published; pass author, round and full SHAs.',
  phases: [
    { title: 'Review', detail: 'Opus 5.5 and GPT-6.1 Sol (Astra in deep mode) review independently, plus a security lens from the non-author side' },
    { title: 'Verify', detail: 'each finding is challenged by the other provider' },
  ],
}

// Validate everything before phase()/agent(), including stringified tool arguments.
let input
const problems = []
try { input = typeof args === 'string' ? JSON.parse(args) : args }
catch { problems.push('args must be valid JSON.') }
if (!input || typeof input !== 'object' || Array.isArray(input)) {
  problems.push('args must be an object.')
  input = {}
}
const text = value => typeof value === 'string' && value.trim().length > 0
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
if (!text(input.target)) problems.push('Missing or invalid args.target (NOT repo/base/since) — say what to review (a diff range, paths, or a document).')
if (input.context !== undefined && typeof input.context !== 'string') problems.push('context must be a string.')
for (const key of ['quick', 'deep', 'force']) {
  if (input[key] !== undefined && typeof input[key] !== 'boolean') problems.push(`${key} must be a boolean.`)
}
if (input.author !== undefined && !['claude', 'gpt'].includes(input.author)) problems.push('author must be "claude" or "gpt".')
const quick = input.quick === true
const deep = input.deep === true
const author = input.author === 'gpt' ? 'gpt' : 'claude'
if (quick && !['claude', 'gpt'].includes(input.author)) problems.push('Quick mode needs args.author: "claude" or "gpt" (who wrote the work).')
if (quick && deep) problems.push('quick and deep cannot be combined — deep is a full review with GPT-6 Astra.')
if (deep && !['security', 'algorithmic', 'concurrency', 'cross-cutting'].includes(input.deepReason)) {
  problems.push('deep: true needs deepReason: security, algorithmic, concurrency, or cross-cutting.')
}
if (deep && (!text(input.deepJustification) || /[\r\n\u2028\u2029]/.test(input.deepJustification))) {
  problems.push('deep: true needs a non-empty, one-line deepJustification.')
}
if (!deep && (input.deepReason !== undefined || input.deepJustification !== undefined)) problems.push('deepReason/deepJustification require deep: true.')
for (const key of ['since', 'prior']) {
  if (input[key] !== undefined && !text(input[key])) problems.push(key === 'prior'
    ? 'prior must be a single non-empty string (join findings with newlines), not an array.'
    : 'since must be a non-empty string.')
}
const since = text(input.since) ? input.since.trim() : null
const prior = text(input.prior) ? input.prior.trim() : null
if (!(Number.isInteger(input.round) && input.round >= 1)) problems.push('round is required and must be a positive integer (1 for the first whole-change review).')
const round = input.round
if (since && !prior) problems.push('since needs prior: pass the previous round\'s blocking findings and any dismissed findings with the reason.')
if ((since || prior) && round === 1) problems.push('Follow-up reviews (since/prior) require round 2 or later, after a whole-change review in the same mode.')
if (round > 3 && input.force !== true) problems.push(`Round ${round} refused: the review cap is 3. Make a structural fix or ask the user; only then pass force: true.`)
if (input.headSha !== undefined && !sha(input.headSha)) problems.push('headSha must be the full current HEAD SHA when supplied (workflow scripts cannot read git or files).')
if (input.baseSha !== undefined && !sha(input.baseSha)) problems.push('baseSha must be the full base commit SHA, not a moving ref.')
if (input.cachedReview !== undefined && (!input.cachedReview || typeof input.cachedReview !== 'object' || Array.isArray(input.cachedReview))) problems.push('cachedReview must be a previous review result object.')
if (input.cachedReview !== undefined && input.baseSha === undefined) problems.push('cachedReview requires baseSha so a changed base cannot reuse a verdict.')
const reviewExample = '{"target":"git diff <baseSha>..<headSha> in <abs repo path>","context":"<intent, issue #>","author":"gpt","round":1,"headSha":"<full HEAD SHA>","baseSha":"<full base SHA>"}'
const followUpExample = 'Round 2+: add "since":"<full SHA reviewed last>","prior":"<ONE string: blocking/unverified findings + dismissed findings with reasons>","round":2.'
const shaHelp = 'Replace placeholders first: resolve SHAs with git rev-parse (40 hex for SHA-1, 64 for SHA-256), not short SHAs or moving refs; author is "claude" or "gpt".'
if (problems.length) return { passed: false, error: `Invalid review arguments:\n- ${problems.join('\n- ')}\nCopy-paste example: ${reviewExample}\n${followUpExample}\n${shaHelp}`, problems }

const target = input.target
const context = input.context ? `\n\nIntent / spec of the work:\n${input.context}` : ''
// No fs/Node globals in the workflow realm. The caller carries the previous result unchanged;
// never pretend that the script has checked the working tree or persisted a cross-session cache.
// Compact FNV-1a/128 identity, not authentication. Do not echo the potentially huge
// target/spec back in every notification just to transport a cache lookup key.
const fingerprint = value => {
  let hash = 144066263297769815596495629667062367629n
  const mask = (1n << 128n) - 1n
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    for (const byte of [code & 255, code >>> 8]) hash = ((hash ^ BigInt(byte)) * 309485009821345068724781371n) & mask
  }
  return hash.toString(16).padStart(32, '0')
}
// Pinned models, not provider labels. Keep synchronized with agent frontmatter.
const AGENT_MODELS = {
  reviewer: 'anthropic/claude-opus-5-5',
  'sol-reviewer': 'anthropic/claude-sonnet-5-5',
  'second-opinion': 'anthropic/claude-opus-5-5',
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

// Cache identities include the pinned routing, not just caller-supplied diff identity.
const cacheKey = 'review-v2-security:' + fingerprint(JSON.stringify({ target, headSha: input.headSha, baseSha: input.baseSha ?? null,
  mode: deep ? 'deep' : 'full', author, context: input.context ?? '', routing: AGENT_MODELS, runtimeStamp: RUNTIME_STAMP,
  deepReason: input.deepReason ?? null, deepJustification: input.deepJustification ?? null }))
// The security lens runs on the provider that did NOT write the work (same rule as `other` below).
const secSide = author === 'claude' ? 'gpt' : 'claude'
const cacheAgentTypes = {
  'review:claude': 'reviewer', 'review:gpt': deep ? 'second-opinion' : 'sol-reviewer',
  [`review:security-${secSide}`]: secSide === 'claude' ? 'reviewer' : deep ? 'second-opinion' : 'sol-reviewer',
  'verify:claude-by-gpt': deep || author === 'gpt' ? 'second-opinion' : 'sol-reviewer',
  'verify:gpt-by-claude': 'reviewer',
  // The security lane is verified by the author side (the provider that is not reviewing it).
  [`verify:security-${secSide}-by-${secSide === 'claude' ? 'gpt' : 'claude'}`]: secSide === 'claude' ? (deep || author === 'gpt' ? 'second-opinion' : 'sol-reviewer') : 'reviewer',
}
const cachedProvenance = run => ({ ...run, models: run?.effective })
const reusableRun = run => runtimeAvailable(cachedProvenance(run), runtimeModels(cachedProvenance(run)))
const completeCacheCoverage = (cached, runs) => {
  const labels = new Set(runs.map(run => run?.label))
  return runs.length === cached.runtimeCallCount && labels.size === runs.length &&
    labels.has('review:claude') && labels.has('review:gpt') && labels.has(`review:security-${secSide}`)
}
const validCachedRole = (run, agentType) => Boolean(agentType) && run.agentType === agentType && run.ok === true
const checkCachedRun = run => {
  const agentType = cacheAgentTypes[run?.label]
  if (!validCachedRole(run, agentType)) {
    runtimeProblems.push('Cached review: no runtime model record (invalid reviewer role or status)')
    return
  }
  record({ runtimeProvenance: cachedProvenance(run) }, { label: run.label, agentType }, agentType)
}
const checkCachedCoverage = cached => {
  const runs = Array.isArray(cached.reviewers) ? cached.reviewers : []
  if (!completeCacheCoverage(cached, runs)) runtimeProblems.push('Cached review: no runtime model record (incomplete reviewer/verifier coverage)')
  runs.forEach(checkCachedRun)
}
const cached = input.cachedReview
if (!quick && !since && !prior && input.headSha && input.baseSha && cached?.reviewCacheKey === cacheKey &&
    cached.passed === true && cached.complete === true && cached.mode === (deep ? 'deep' : 'full') &&
    cached.blockingCount === 0 && cached.unverifiedCount === 0 &&
    Array.isArray(cached.incomplete) && cached.incomplete.length === 0 &&
    Array.isArray(cached.blocking) && cached.blocking.length === 0 &&
    Array.isArray(cached.unverified) && cached.unverified.length === 0) {
  checkCachedCoverage(cached)
  if (runtimeProblems.length === 0) return { ...cached, reviewers: runtimeReviewers(), cached: true }
  const { reviewCacheKey, ...uncertified } = cached
  return { ...uncertified, cached: false, passed: false, complete: false, incomplete: runtimeProblems,
    reviewers: runtimeReviewers(), next: runtimeNext }
}

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
  claude: { agentType: 'reviewer', name: 'Opus 5.5' },
  gpt: deep
    ? { agentType: 'second-opinion', name: 'Opus 5.5 high' }
    : { agentType: 'sol-reviewer', name: 'Sonnet 5.5' },
}
const QUICK_REVIEWERS = {
  claude: { agentType: 'reviewer', name: 'Opus 5.5' },
  gpt: { agentType: 'sol-reviewer', name: 'Sonnet 5.5' },
}
const other = side => (side === 'claude' ? 'gpt' : 'claude')
const ASTRA = { agentType: 'second-opinion', name: 'Opus 5.5 high' }
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
      : `Fix the blocking findings, commit, then rerun with headSha: <new full HEAD SHA>, since: ${input.headSha ?? '<HEAD SHA reviewed now>'}, prior: <blocking list>, round: ${round + 1}.`

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

const verdict = fit({
  mode: deep ? 'deep' : 'full',
  round,
  passed,
  complete,
  incomplete,
  reviewers: runtimeReviewers(), runtimeCallCount: runtimeRuns.length,
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
// Only complete, passing, whole-change full reviews are eligible for reuse.
if (passed && !since && !prior && input.headSha && input.baseSha && verdict.reviewers.every(reusableRun)) verdict.reviewCacheKey = cacheKey
return verdict
