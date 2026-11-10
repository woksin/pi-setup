/**
 * review.js — cross-provider review with adversarial verification.
 * Enforces all argument/round/deep-mode rules before spending reviewer tokens,
 * and reuses caller-carried full passing verdicts for identical committed scope.
 *
 * profile:begin summary
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
 * profile:end summary
 *
 * GENERATED PER PROFILE: this file is the source. Every agent/profiles/<name>/workflows/review.js is
 * rendered from it by tools/sync-review-workflow.mjs using tools/review-profiles.json; only the
 * profile:begin/profile:end blocks differ. Edit the source and the config, then regenerate.
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
 *                        Only after a whole-change review (same mode, or full after a deep round). Reviewers look only at
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
 *   cachedReview?: object — previous passing result, unchanged; its slim receipt (reviewCacheKey, reviewers,
 *                        runtimeCallCount) is validated, see INSTALL.md for cache limitations.
 *   repair?: object — previous coverage-incomplete full/deep result, unchanged; retry only its missing lanes
 *                        with identical args and SHAs, without since/prior or cachedReview (at most two repairs).
 * }
 *
 * Gate: only BLOCKING findings fail a review — critical/major issues a maintainer would block merge on
 * (regression, data loss, security, spec violation, broken build/tests), confirmed by the other provider
 * (full mode). Minor issues and nits come back in `advisory`: fix them in the same pass if cheap, never
 * start another review round for them.
 *
 * Result: every return carries `passed` (boolean). It is true only when the review completed
 * (every reviewer and verifier returned) and no blocking finding is confirmed or unverified,
 * and every reviewer's runtime-recorded model, when a record exists, equals the agent's
 * configured model. Fallback, malformed or unavailable records make it incomplete: no retry, no override.
 * Transitional (pi-setup#87): a reviewer with no record at all (session started before model-provenance
 * was installed) is reported as `unavailable (pre-update session)`, does not block and never makes
 * the result reusable from cache; remove once no pre-update sessions remain.
 * Two result shapes, both built to fit the parent's notification, which cuts the pretty-printed JSON at
 * 4000 chars (every field is clipped and sanitised, every list capped; the test bound is 3900):
 *   - passed: verdict, reviewCacheKey (when reusable) and a slim receipt per run {label, agentType, expected,
 *     effective, ok}, then capped advisory/coverage lines. The key and receipt come first and are never trimmed.
 *   - not passed: verdict, blocking findings (capped, then an explicit `…N more` entry; blockingCount is the real
 *     count), unverified, incomplete, one-line reviewers; never carries a cache key. Coverage-only failures
 *     may carry repair evidence; a repaired result carries repaired/repairAttempt and is never cacheable.
 * Repair keys, like reviewCacheKey, are non-cryptographic digests: identity and tamper-evidence against accidental
 * edits, not authentication. The workflow realm has no secret or crypto; a caller who reimplements the digest
 * can forge evidence, exactly as with cachedReview. The parent/orchestrator must pass the earlier result unchanged.
 * A cache hit validates the slim receipt only (unique labels, allowed roles, required lanes, exact
 * runtimeCallCount, every run ok on its current pinned model); full provenance was verified when the receipt
 * was issued. A failed, missing or incomplete review is never a pass — gate merges on `passed === true`,
 * not on an empty `confirmed` list.
 *
 * Run: "run the review workflow on the changes in git diff main...HEAD"
 */
export const meta = {
  name: 'review',
  // profile:begin meta
  description: 'Cross-provider code/work review (Opus 5.5 + GPT-6.1 Sol; GPT-6 Astra with deep: true); only blocking findings gate, verified by the other provider',
  whenToUse: 'Reviewing a diff, change set, document or plan before it is merged or published; pass author, round and full SHAs.',
  phases: [
    { title: 'Review', detail: 'Opus 5.5 and GPT-6.1 Sol (Astra in deep mode) review independently, plus a cross-provider security lens' },
    { title: 'Verify', detail: 'each finding is challenged by the other provider' },
  ],
  // profile:end meta
}

// profile:begin routing
// Pinned models, not provider labels. Keep synchronized with agent frontmatter.
const AGENT_MODELS = {
  reviewer: 'anthropic/claude-opus-5-5',
  'sol-reviewer': 'openai-codex/gpt-6.1-sol',
  'second-opinion': 'openai-codex/gpt-6-astra',
}
// Review sides in lane order; the first side is the default author side. Lane, security and verify labels derive from the keys.
const ROUTING = {
  claude: { agentType: 'reviewer', name: 'Opus 5.5' },
  gpt: { agentType: 'sol-reviewer', name: 'GPT-6.1 Sol' },
}
// Sides that run on a different agent in deep mode.
const DEEP_ROUTING = {
  gpt: { agentType: 'second-opinion', name: 'GPT-6 Astra' },
}
const QUICK_ROUTING = {
  claude: { agentType: 'reviewer', name: 'Opus 5.5' },
  gpt: { agentType: 'sol-reviewer', name: 'GPT-6.1 Sol' },
}
// Accepted args.author values -> the side that wrote the work.
const AUTHOR_SIDES = { claude: 'claude', gpt: 'gpt' }
// Who checks `side`'s findings when the work was written by `author` (outside deep mode); null = always the other side.
const SAME_AUTHOR_VERIFIER = { side: 'claude', author: 'gpt', agentType: 'second-opinion', name: 'GPT-6 Astra' }
// profile:end routing

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
const SIDES = Object.keys(ROUTING)
const authorNames = Object.keys(AUTHOR_SIDES).map(name => `"${name}"`).join(', ')
const knownAuthor = typeof input.author === 'string' && Object.hasOwn(AUTHOR_SIDES, input.author)
if (input.author !== undefined && !knownAuthor) problems.push(`author must be one of ${authorNames}.`)
const quick = input.quick === true
const deep = input.deep === true
// The side that wrote the work (default: the first side).
const author = knownAuthor ? AUTHOR_SIDES[input.author] : SIDES[0]
if (quick && !knownAuthor) problems.push(`Quick mode needs args.author: one of ${authorNames} (who wrote the work).`)
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
if ((since || prior) && round === 1) problems.push('Follow-up reviews (since/prior) require round 2 or later, after a whole-change review.')
if (round > 3 && input.force !== true) problems.push(`Round ${round} refused: the review cap is 3. Make a structural fix or ask the user; only then pass force: true.`)
if (input.headSha !== undefined && !sha(input.headSha)) problems.push('headSha must be the full current HEAD SHA when supplied (workflow scripts cannot read git or files).')
if (input.baseSha !== undefined && !sha(input.baseSha)) problems.push('baseSha must be the full base commit SHA, not a moving ref.')
if (input.cachedReview !== undefined && (!input.cachedReview || typeof input.cachedReview !== 'object' || Array.isArray(input.cachedReview))) problems.push('cachedReview must be a previous review result object.')
if (input.cachedReview !== undefined && input.baseSha === undefined) problems.push('cachedReview requires baseSha so a changed base cannot reuse a verdict.')
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const repairing = input.repair !== undefined
if (repairing) {
  if (!plainObject(input.repair)) problems.push('repair must be a previous review result object, passed unchanged.')
  if (input.cachedReview !== undefined) problems.push('repair and cachedReview cannot be combined.')
  if (!input.headSha || !input.baseSha) problems.push('repair requires headSha and baseSha for the original range.')
  if (quick || input.since !== undefined || input.prior !== undefined) problems.push('repair cannot be combined with quick, since or prior; retry the original range.')
}
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
// Why a partition failed: `agentError(label)` is an optional host global (absent on older hosts, so this degrades to no reason).
const failureReason = label => {
  try { const r = typeof agentError === 'function' ? agentError(label) : undefined; return typeof r === 'string' && r.trim() ? shown(r.trim(), 60) : '' } catch { return '' }
}
const failedText = (name, label) => { const r = failureReason(label); return r ? `${name} review failed: ${r}` : `${name} review failed` }
const runtimeReviewers = () => runtimeRuns.sort((a, b) => a.label.localeCompare(b.label))
// A receipt is only issued when every run carried a full, valid provenance record (checked here, not on reuse).
const reusableRun = run => { const p = { ...run, models: run?.effective }; return run?.ok === true && runtimeAvailable(p, runtimeModels(p)) }
// End runtime recording.

// Routing derived from the profile block: lanes, security lens and verifiers are keyed by side.
const other = side => (side === SIDES[0] ? SIDES[1] : SIDES[0])
const REVIEWERS = Object.fromEntries(SIDES.map(side => [side, (deep && DEEP_ROUTING[side]) || ROUTING[side]]))
const QUICK_REVIEWERS = QUICK_ROUTING
// Who checks the findings reported by `side`: normally the other side; a same-author verifier
// overrides it (e.g. Sol must not judge findings against Sol-written work).
const verifierFor = side =>
  SAME_AUTHOR_VERIFIER && side === SAME_AUTHOR_VERIFIER.side && author === SAME_AUTHOR_VERIFIER.author && !deep
    ? SAME_AUTHOR_VERIFIER : REVIEWERS[other(side)]
// The security lens runs on the side that did NOT write the work.
const secSide = other(author)

// Cache identities include the pinned routing, not just caller-supplied diff identity.
const cacheKey = 'review-v4-coverage:' + fingerprint(JSON.stringify({ target, headSha: input.headSha, baseSha: input.baseSha ?? null,
  mode: deep ? 'deep' : 'full', author, context: input.context ?? '', routing: AGENT_MODELS, lanes: [ROUTING, DEEP_ROUTING, SAME_AUTHOR_VERIFIER],
  runtimeStamp: RUNTIME_STAMP, deepReason: input.deepReason ?? null, deepJustification: input.deepJustification ?? null }))
// Allowed receipt roles. The security lane is verified by the side that did not review it.
const cacheAgentTypes = {}
for (const side of SIDES) {
  cacheAgentTypes[`review:${side}`] = REVIEWERS[side].agentType
  cacheAgentTypes[`verify:${side}-by-${other(side)}`] = verifierFor(side).agentType
}
cacheAgentTypes[`review:security-${secSide}`] = REVIEWERS[secSide].agentType
cacheAgentTypes[`verify:security-${secSide}-by-${other(secSide)}`] = verifierFor(secSide).agentType

// ---- result shape: bounded by construction, never measured-then-shrunk ----
const isBlocking = f => f.blocking === true && (f.severity === 'critical' || f.severity === 'major')
const clip = (t, n) => (typeof t === 'string' && t.length > n ? t.slice(0, n) + '…' : t)
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
// Result text is clipped, then reduced to characters JSON.stringify never escapes, so the caps below are exact.
const shown = (t, n) => clip(typeof t === 'string' ? t : '', n)
  .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/"/g, "'").replace(/\\/g, '/').replace(LONE_SURROGATE, '?')
const oneLine = (f, n = 110) => shown(`(${f.severity}) ${f.location}: ${f.problem}`, n)
// Security holes found in touched code that predate the change: surfaced separately so they are never lost
// in the advisory list. The caller tracks them (private advisory for exploitable ones).
const preExisting = list => list.filter(f => typeof f.problem === 'string' && f.problem.startsWith('PRE-EXISTING:')).map(f => oneLine(f))
const full = f => ({
  severity: shown(f.severity, 10), location: shown(f.location, 70), problem: shown(f.problem, 160), fix: shown(f.fix, 80),
  ...(f.foundBy ? { foundBy: shown(f.foundBy, 40) } : {}), ...(f.note ? { note: shown(f.note, 80) } : {}),
})
const capped = (items, cap, show, more) => {
  const out = items.slice(0, cap).map(show)
  if (items.length > cap) out.push(more(items.length - cap))
  return out
}
const lines = (items, cap, n) => capped(items.filter(item => typeof item === 'string'), cap, item => shown(item, n), k => `…${k} more`)
const nextStep = passed =>
  passed
    ? 'Passed. Fix cheap advisory items in the same change if you like; do not start another review round for them.'
    : round >= 3
      ? 'Not passed at the round cap. Make a structural fix for the whole class of issue or ask the user; do not loop.'
      : `Fix the blocking findings, commit, then rerun with headSha: <new full HEAD SHA>, since: ${input.headSha ?? '<HEAD SHA reviewed now>'}, prior: <blocking list>, round: ${round + 1}.`
// Slim receipt: only the provenance-verified fields. Session, timestamps and counts are not carried.
const slimRun = run => ({
  label: shown(run?.label, 40), agentType: shown(run?.agentType, 20), expected: shown(run?.expected, 40),
  effective: Array.isArray(run?.effective) ? run.effective.slice(0, 2).map(model => shown(model, 40)) : [], ok: run?.ok === true,
  ...(run?.provenance === 'unavailable (pre-update session)' ? { provenance: run.provenance } : {}),
})
const runLine = run => `${shown(run?.label, 40) || 'invalid record'}: ${run?.ok === true ? 'ok' : 'INCOMPLETE'}`
const RUNS_MAX = 6
// Passed: verdict, cache key and receipt first. Not passed: verdict, blocking, unverified, incomplete first.
const buildResult = r => {
  const out = { mode: r.mode, round, passed: r.passed, complete: r.complete, blockingCount: r.blockingCount, unverifiedCount: r.unverifiedCount, next: r.next }
  if (r.repaired) { out.repaired = true; out.repairAttempt = r.repairAttempt }
  if (r.repair) out.repair = r.repair
  if (r.cached !== undefined) out.cached = r.cached
  if (r.reviewedBy) out.reviewedBy = shown(r.reviewedBy, 40)
  if (r.reviewCacheKey) out.reviewCacheKey = r.reviewCacheKey
  if (r.passed) {
    const runs = r.reviewers.slice(0, RUNS_MAX)
    out.runtimeCallCount = runs.length
    out.reviewers = runs.map(slimRun)
    out.blocking = []
    out.unverified = []
    out.incomplete = []
    out.coverageNotes = lines(r.coverageNotes, 3, 150)
    out.advisory = lines(r.advisory, 4, 110)
    out.preExistingSecurity = lines(r.preExisting, 3, 110)
    out.summaries = r.summaries.slice(0, 3).map(s => ({ by: shown(s.by, 30), summary: shown(s.summary, 70) }))
  } else {
    out.blocking = capped(r.blocking, 3, full, k => `…${k} more blocking findings omitted (blockingCount=${r.blockingCount})`)
    out.unverified = capped(r.unverified, 2, f => oneLine(f, 140), k => `…${k} more unverified findings omitted (unverifiedCount=${r.unverifiedCount})`)
    out.incomplete = lines(r.incomplete, 4, 170)
    out.reviewers = capped(r.reviewers, RUNS_MAX, runLine, k => `…${k} more runs`)
    out.advisory = lines(r.advisory, 2, 100)
    out.preExistingSecurity = lines(r.preExisting, 1, 100)
  }
  out.rejectedCount = r.rejectedCount ?? 0
  return out
}

// Cache hit: validate the slim receipt only. Full provenance was verified when the receipt was issued;
// the key is identity, not authentication. Still enforced: unique labels, allowed roles, the required
// review and security lanes, an exact runtimeCallCount, and every run ok on its current pinned model.
const receiptRoleOk = run => run !== null && typeof run === 'object' && typeof run.label === 'string' &&
  Object.hasOwn(cacheAgentTypes, run.label) && run.agentType === cacheAgentTypes[run.label] && run.ok === true
const receiptModelOk = run => {
  const pinned = AGENT_MODELS[run.agentType]
  return run.expected === pinned && Array.isArray(run.effective) && run.effective.length > 0 && run.effective.every(model => model === pinned)
}
const laneLabels = lane => [`review:${lane.key}`, `verify:${lane.key}-by-${other(lane.side)}`]
const repairDigest = evidence => 'review-repair-v1:' + fingerprint(JSON.stringify({ cacheKey, round,
  attempt: evidence.attempt, missing: evidence.missing, completed: evidence.completed,
  advisory: evidence.advisory, coverageNotes: evidence.coverageNotes, preExisting: evidence.preExisting }))
const repairLinesOk = (value, cap, width) => Array.isArray(value) && value.length <= cap &&
  value.every(item => typeof item === 'string' && item.length <= width + 1 && shown(item, width) === item)
const repairRunsOk = (runs, missing, lanes) => {
  if (!Array.isArray(runs) || runs.length > RUNS_MAX) return false
  const labels = new Set(runs.map(run => run?.label))
  const kept = lanes.filter(lane => !missing.includes(lane.key))
  const allowed = new Set(kept.flatMap(laneLabels))
  return labels.size === runs.length && kept.every(lane => labels.has(`review:${lane.key}`)) &&
    runs.every(run => receiptRoleOk(run) && receiptModelOk(run) && !Object.hasOwn(run, 'provenance') && allowed.has(run.label))
}
const repairProblems = (r, lanes) => {
  const errors = []
  const e = r.repair
  if (r.passed !== false || r.complete !== false || r.blockingCount !== 0 || r.unverifiedCount !== 0 ||
      r.mode !== (deep ? 'deep' : 'full') || r.round !== round) errors.push('repair requires a coverage-incomplete result from this mode and round.')
  if (!plainObject(e)) return [...errors, 'repair evidence is missing.']
  if (Number.isInteger(e.attempt) && e.attempt > 2) errors.push('Repair attempt cap reached; ask the user rather than retry again.')
  const keys = new Set(lanes.map(lane => lane.key))
  const missingOk = Array.isArray(e.missing) && e.missing.length > 0 && e.missing.length < lanes.length &&
    new Set(e.missing).size === e.missing.length && e.missing.every(key => typeof key === 'string' && keys.has(key))
  if (e.v !== 1 || typeof e.key !== 'string' || !Number.isInteger(e.attempt) || e.attempt < 1 || e.attempt > 2 ||
      e.round !== round || !missingOk || !repairRunsOk(e.completed, e.missing, lanes) ||
      !repairLinesOk(e.advisory, 3, 90) || !repairLinesOk(e.coverageNotes, 3, 120) || !repairLinesOk(e.preExisting, 3, 100)) {
    errors.push('repair evidence has invalid partitions, receipts or bounded fields.')
  }
  if (e.key !== repairDigest(e)) errors.push('repair evidence does not match this review identity or was altered')
  return errors
}
const buildRepair = (lanes, completedKeys, preserved, notes) => {
  const completed = [...preserved]
  const missing = []
  for (const lane of lanes) {
    const labels = laneLabels(lane)
    if (preserved.some(run => run.label === labels[0])) continue
    const runs = runtimeReviewers().filter(run => labels.includes(run.label))
    if (completedKeys.has(lane.key) && runs.some(run => run.label === labels[0]) && runs.every(reusableRun)) completed.push(...runs.map(slimRun))
    else missing.push(lane.key)
  }
  if (missing.length === 0 || missing.length === lanes.length) return undefined
  const evidence = { v: 1, attempt: repairing ? input.repair.repair.attempt + 1 : 1, round,
    missing: missing.sort(), completed: completed.sort((a, b) => a.label.localeCompare(b.label)),
    advisory: lines(notes.advisory, 3, 90).slice(0, 3), coverageNotes: lines(notes.coverageNotes, 3, 120).slice(0, 3),
    preExisting: lines(notes.preExisting, 3, 100).slice(0, 3) }
  return { v: evidence.v, key: repairDigest(evidence), ...evidence }
}
const receiptProblems = receipt => {
  const runs = Array.isArray(receipt.reviewers) ? receipt.reviewers : []
  const labels = new Set(runs.map(run => run?.label))
  const required = [...SIDES.map(side => `review:${side}`), `review:security-${secSide}`]
  const problems = []
  if (runs.length !== receipt.runtimeCallCount || labels.size !== runs.length || !required.every(label => labels.has(label))) {
    problems.push('Cached review: no runtime model record (incomplete reviewer/verifier coverage)')
  }
  for (const run of runs) {
    if (!receiptRoleOk(run)) problems.push('Cached review: no runtime model record (invalid reviewer role or status)')
    else if (!receiptModelOk(run)) {
      const models = Array.isArray(run.effective) ? run.effective.map(model => shown(String(model), 40)).join(', ') : ''
      problems.push(`Cached review: ${run.label} ran on ${models || 'no runtime model record'}, not ${AGENT_MODELS[run.agentType]}`)
    }
  }
  return problems
}
const cached = input.cachedReview
if (!quick && !since && !prior && input.headSha && input.baseSha && cached?.reviewCacheKey === cacheKey &&
    cached.passed === true && cached.complete === true && cached.mode === (deep ? 'deep' : 'full') &&
    cached.blockingCount === 0 && cached.unverifiedCount === 0 &&
    Array.isArray(cached.incomplete) && cached.incomplete.length === 0 &&
    Array.isArray(cached.blocking) && cached.blocking.length === 0 &&
    Array.isArray(cached.unverified) && cached.unverified.length === 0) {
  const problems = receiptProblems(cached)
  const mode = deep ? 'deep' : 'full'
  if (problems.length === 0) {
    const strings = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
    const summaries = Array.isArray(cached.summaries) ? cached.summaries.filter(s => s && typeof s.by === 'string' && typeof s.summary === 'string') : []
    return buildResult({ mode, passed: true, complete: true, blockingCount: 0, unverifiedCount: 0, next: nextStep(true), cached: true,
      reviewCacheKey: cacheKey, reviewers: cached.reviewers.slice().sort((a, b) => a.label.localeCompare(b.label)),
      coverageNotes: strings(cached.coverageNotes), advisory: strings(cached.advisory), preExisting: strings(cached.preExistingSecurity), summaries })
  }
  return buildResult({ mode, passed: false, complete: false, blockingCount: 0, unverifiedCount: 0, next: runtimeNext, cached: false,
    incomplete: problems, reviewers: Array.isArray(cached.reviewers) ? cached.reviewers : [], blocking: [], unverified: [], advisory: [], preExisting: [] })
}

const COVERAGE = 'Set coverage honestly: complete = every file and section of the requested scope was examined for your lens, ' +
  'even if some verification (browser run, build, test run, network lookup) could not be run; ' +
  'partial = some file, hunk or section in scope was NOT examined, or (security lens) a required security check could not be performed; ' +
  'none = nothing examined. Anything that could not be run goes in coverageNote as UNRUN: <check>: <reason>.'
const coverageNotesFor = (by, res) => res.coverage === 'complete' && res.coverageNote?.trim()
  ? [`${by}: ${clip(res.coverageNote.trim(), 200)}`] : []

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
    coverage: {
      type: 'string',
      enum: ['complete', 'partial', 'none'],
      description: COVERAGE,
    },
    coverageNote: { type: 'string' },
  },
  required: ['summary', 'findings', 'coverage'],
}

// A reviewer slot that did not fully review is never a pass, even with an empty findings list.
const coverageProblem = (name, res) =>
  res.coverage === 'complete'
    ? null
    : `${name} did not complete its review (coverage: ${res.coverage ?? 'missing'}${res.coverageNote ? `; ${clip(res.coverageNote, 200)}` : ''})`

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
  'Report only real problems — an empty findings list is a valid answer. ' +
  COVERAGE + RUBRIC

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
  'callers) keep their full severity. An empty findings list is a valid answer. ' +
  COVERAGE + ' Required security checks are the trust-boundary read of every touched path and the hostile-case spec check ' +
  'listed above, plus any checks the target/brief names as required (secret scan, dependency audit). Unrunnable other checks stay notes.'

// The security lens runs on the provider that did NOT write the work and is verified by the other provider.
const LANES = [
  ...SIDES.map(side => ({ key: side, side, reviewer: REVIEWERS[side], prompt: reviewPrompt })),
  { key: `security-${secSide}`, side: secSide, reviewer: { ...REVIEWERS[secSide], name: `${REVIEWERS[secSide].name} (security)` }, prompt: securityPrompt },
]
if (repairing) {
  const problems = repairProblems(input.repair, LANES)
  if (problems.length) return { passed: false, error: `Invalid review repair:\n- ${problems.join('\n- ')}`, problems }
}
phase('Review')

if (quick) {
  const side = other(author)
  const r = QUICK_REVIEWERS[side]
  const [res, sec] = await parallel([
    () => reviewAgent(reviewPrompt, { agentType: r.agentType, schema: FINDINGS, label: `review:${side}`, phase: 'Review' }, r.name),
    () => reviewAgent(securityPrompt, { agentType: r.agentType, schema: FINDINGS, label: `review:security-${side}`, phase: 'Review' }, `${r.name} (security)`),
  ])
  if (!res) return { mode: 'quick', round, passed: false, error: failedText(r.name, `review:${side}`) }
  if (!sec) return { mode: 'quick', round, passed: false, error: failedText(`${r.name} security`, `review:security-${side}`) }
  // Quick mode has no verifier: security blockers gate unverified (fail closed).
  const all = res.findings.concat(sec.findings.map(f => ({ ...f, foundBy: `${r.name} (security)` })))
  const blocking = all.filter(isBlocking)
  const incomplete = [...runtimeProblems]
  for (const [slotName, slot] of [[r.name, res], [`${r.name} (security)`, sec]]) {
    const cp = coverageProblem(slotName, slot)
    if (cp) incomplete.push(cp)
  }
  const passedQ = blocking.length === 0 && incomplete.length === 0
  return buildResult({
    mode: 'quick', passed: passedQ, complete: incomplete.length === 0, incomplete,
    coverageNotes: [...coverageNotesFor(r.name, res), ...coverageNotesFor(`${r.name} (security)`, sec)],
    reviewers: runtimeReviewers(), reviewedBy: r.name, blockingCount: blocking.length, unverifiedCount: 0,
    summaries: [{ by: r.name, summary: res.summary }], blocking, unverified: [], preExisting: preExisting(all),
    advisory: all.filter(f => !isBlocking(f)).map(f => oneLine(f)),
    next: runtimeProblems.length ? runtimeNext : nextStep(passedQ),
  })
}

const lanes = repairing ? LANES.filter(lane => input.repair.repair.missing.includes(lane.key)) : LANES
const results = await pipeline(
  lanes,
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
    if (!res) return { lane, side, failed: true, reason: failureReason(`review:${lane.key}`) }
    // Only blocking claims are adversarially verified; everything else is advisory and never gates.
    const toCheck = res.findings.map((f, i) => ({ f, i })).filter(x => isBlocking(x.f))
    if (toCheck.length === 0) return { lane, side, summary: res.summary, findings: res.findings, coverage: res.coverage, coverageNote: res.coverageNote, verdicts: [] }
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
    return { lane, side, summary: res.summary, findings: res.findings, coverage: res.coverage, coverageNote: res.coverageNote, verdicts: v ? v.verdicts : null }
  },
)

const confirmed = []
const rejected = []
const unverified = []
const advisory = []
const summaries = []
const coverageNotes = []
const incomplete = []
const completedKeys = new Set()

// A pipeline item that threw comes back as null; treat it as a failed review, never skip it.
results.forEach((r, i) => {
  if (!r) incomplete.push(`${lanes[i].reviewer.name} review did not complete`)
})

for (const r of results.filter(Boolean)) {
  const by = r.lane.reviewer.name
  if (r.failed) {
    const why = r.reason ? `: ${r.reason}` : ''
    log(`${by} review failed${why}`)
    summaries.push({ by, summary: 'REVIEW FAILED' })
    incomplete.push(`${by} review failed${why}`)
    continue
  }
  const incompleteBefore = incomplete.length
  const cp = coverageProblem(by, r)
  if (cp) incomplete.push(cp)
  coverageNotes.push(...coverageNotesFor(by, r))
  if (r.findings.some(isBlocking) && !r.verdicts) incomplete.push(`verification of ${by}'s findings failed`)
  summaries.push({ by, summary: r.summary })
  // Exactly one verdict per blocking finding: a verdict for any other index is untrusted output, so the lane is incomplete.
  if (r.verdicts && r.verdicts.some(v => !Number.isInteger(v?.index) || !r.findings[v.index] || !isBlocking(r.findings[v.index])))
    incomplete.push(`verification of ${by}'s findings returned a verdict for an unknown finding`)
  const checker = verifierFor(r.side).name
  r.findings.forEach((f, i) => {
    const item = { ...f, foundBy: by }
    if (!isBlocking(f)) return advisory.push(item)
    // Missing, duplicate (identical or contradictory) verdicts leave the finding unverified.
    const matches = r.verdicts ? r.verdicts.filter(v => v?.index === i) : []
    const verdict = matches.length === 1 ? matches[0] : null
    // Fail closed: anything not positively refuted or positively downgraded keeps blocking.
    if (!verdict || verdict.status === 'uncertain' || !['blocks', 'not-blocking', 'refuted'].includes(verdict.status))
      unverified.push({ ...item, note: verdict ? verdict.reason : matches.length > 1 ? 'duplicate verdicts' : 'no verdict' })
    else if (verdict.status === 'blocks') confirmed.push({ ...item, confirmedBy: checker, note: verdict.reason })
    else if (verdict.status === 'not-blocking') advisory.push({ ...item, severity: 'minor', downgradedBy: checker })
    else rejected.push({ ...item, rejectedBy: checker, reason: verdict.reason })
  })
  if (incomplete.length === incompleteBefore) completedKeys.add(r.lane.key)
}

const order = { critical: 0, major: 1, minor: 2, nit: 3 }
confirmed.sort((a, b) => order[a.severity] - order[b.severity])
advisory.sort((a, b) => order[a.severity] - order[b.severity])
incomplete.push(...runtimeProblems)
const preserved = repairing ? input.repair.repair.completed : []
const reviewers = repairing ? [...preserved, ...runtimeReviewers()].sort((a, b) => a.label.localeCompare(b.label)) : runtimeReviewers()
if (repairing) {
  for (const lane of lanes) {
    const runs = runtimeReviewers().filter(run => laneLabels(lane).includes(run.label))
    if (!runs.some(run => run.label === `review:${lane.key}`) || !runs.every(reusableRun)) incomplete.push(`${lane.reviewer.name} review has no reusable runtime provenance`)
  }
  if (!LANES.every(lane => reviewers.some(run => run.label === `review:${lane.key}`))) incomplete.push('Combined repair is missing a review lane.')
}
const complete = incomplete.length === 0
const passed = complete && confirmed.length === 0 && unverified.length === 0
log(`${confirmed.length} blocking, ${advisory.length} advisory, ${rejected.length} rejected, ${unverified.length} unverified — ${passed ? 'PASSED' : 'NOT PASSED'}`)
if (!complete) log(`Incomplete: ${incomplete.join('; ')}`)

const earlier = repairing ? input.repair.repair : { advisory: [], coverageNotes: [], preExisting: [] }
const notes = {
  advisory: [...earlier.advisory, ...advisory.map(f => oneLine(f))],
  coverageNotes: [...earlier.coverageNotes, ...coverageNotes],
  preExisting: [...earlier.preExisting, ...preExisting(advisory)],
}
const repair = !passed && confirmed.length === 0 && unverified.length === 0 && runtimeProblems.length === 0 &&
  input.headSha && input.baseSha && !since && !prior ? buildRepair(LANES, completedKeys, preserved, notes) : undefined
const reusable = !repairing && passed && !since && !prior && input.headSha && input.baseSha && runtimeReviewers().every(reusableRun)
const verdict = buildResult({
  mode: deep ? 'deep' : 'full', passed, ...(reusable ? { reviewCacheKey: cacheKey } : {}), complete, incomplete, ...notes, reviewers,
  ...(repairing ? { repaired: true, repairAttempt: input.repair.repair.attempt } : {}), ...(repair ? { repair } : {}),
  blockingCount: confirmed.length, unverifiedCount: unverified.length, summaries,
  blocking: confirmed, unverified, rejectedCount: rejected.length,
  next: runtimeProblems.length ? runtimeNext : repair
    ? `Incomplete: rerun with the same args plus repair: <this result> to retry only: ${repair.missing.join(', ')}. Do not use since/prior for this.`
    : nextStep(passed),
})
return verdict
