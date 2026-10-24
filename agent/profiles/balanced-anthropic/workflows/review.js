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
 * (every reviewer and verifier returned) and no blocking finding is confirmed or unverified.
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
    { title: 'Review', detail: 'Opus 5.5 and GPT-6.1 Sol (Astra in deep mode) review independently' },
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
const cacheKey = 'review-v1:' + fingerprint(JSON.stringify({ target, headSha: input.headSha, baseSha: input.baseSha ?? null,
  mode: deep ? 'deep' : 'full', author, context: input.context ?? '',
  deepReason: input.deepReason ?? null, deepJustification: input.deepJustification ?? null }))
const cached = input.cachedReview
if (!quick && !since && !prior && input.headSha && input.baseSha && cached?.reviewCacheKey === cacheKey &&
    cached.passed === true && cached.complete === true && cached.mode === (deep ? 'deep' : 'full') &&
    cached.blockingCount === 0 && cached.unverifiedCount === 0 &&
    Array.isArray(cached.incomplete) && cached.incomplete.length === 0 &&
    Array.isArray(cached.blocking) && cached.blocking.length === 0 &&
    Array.isArray(cached.unverified) && cached.unverified.length === 0) {
  return { ...cached, cached: true }
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

const isBlocking = f => f.blocking === true && (f.severity === 'critical' || f.severity === 'major')
const clip = (t, n) => (typeof t === 'string' && t.length > n ? t.slice(0, n) + '…' : t)
const oneLine = f => clip(`(${f.severity}) ${f.location}: ${f.problem}`, 160)
const full = f => ({
  severity: f.severity, location: clip(f.location, 120), problem: clip(f.problem, 300), fix: clip(f.fix, 160),
  ...(f.foundBy ? { foundBy: f.foundBy } : {}), ...(f.note ? { note: clip(f.note, 160) } : {}),
})
// Keep the serialized result under the parent notification limit (~4000 chars) without ever dropping
// gate status or the count of blockers: shrink detail step by step, then fall back to one-liners and counts.
const fit = (res, budget = 3600) => {
  const size = () => JSON.stringify(res).length
  if (size() <= budget) return res
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
  const res = await agent(reviewPrompt, { agentType: r.agentType, schema: FINDINGS, label: `review:${side}`, phase: 'Review' })
  if (!res) return { mode: 'quick', round, passed: false, error: `${r.name} review failed` }
  const blocking = res.findings.filter(isBlocking)
  const passedQ = blocking.length === 0
  return fit({
    mode: 'quick', round, passed: passedQ, reviewedBy: r.name, blockingCount: blocking.length,
    summary: clip(res.summary, 400),
    blocking: blocking.map(full), advisory: advisoryList(res.findings.filter(f => !isBlocking(f))),
    next: nextStep(passedQ),
  })
}

const results = await pipeline(
  ['claude', 'gpt'],
  side =>
    agent(reviewPrompt, {
      agentType: REVIEWERS[side].agentType,
      schema: FINDINGS,
      label: `review:${side}`,
      phase: 'Review',
      ...(REVIEWERS[side].reviewEffort ? { effort: REVIEWERS[side].reviewEffort } : {}),
    }),
  async (res, side) => {
    if (!res) return { side, failed: true }
    // Only blocking claims are adversarially verified; everything else is advisory and never gates.
    const toCheck = res.findings.map((f, i) => ({ f, i })).filter(x => isBlocking(x.f))
    if (toCheck.length === 0) return { side, summary: res.summary, findings: res.findings, verdicts: [] }
    const verifier = other(side)
    const checkerAgent = verifierFor(side)
    const list = toCheck
      .map(({ f, i }) => `[${i}] (${f.severity}) ${f.location}: ${f.problem}\n    Suggested fix: ${f.fix}`)
      .join('\n')
    const v = await agent(
      `Another model (${REVIEWERS[side].name}) reviewed ${target} and reported the findings below.${context}\n\n` +
        'Each was claimed to BLOCK merge. Independently check each one against the actual code. Try to refute it. ' +
        'status: "refuted" only if you positively showed the claim is wrong (cite the code); "uncertain" if you ' +
        'could not confirm or refute it (e.g. could not access or run the relevant code); "blocks" if it is real ' +
        'AND a maintainer would refuse to merge until it is fixed (regression, data loss, security, spec violation, ' +
        'broken build/tests); "not-blocking" if it is real but minor, pre-existing or hypothetical. ' +
        'Return one verdict per index.' + scope + '\n\n' +
        list,
      { agentType: checkerAgent.agentType, schema: VERDICTS, label: `verify:${side}-by-${verifier}`, phase: 'Verify' },
    )
    return { side, summary: res.summary, findings: res.findings, verdicts: v ? v.verdicts : null }
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
  if (!r) incomplete.push(`${REVIEWERS[['claude', 'gpt'][i]].name} review did not complete`)
})

for (const r of results.filter(Boolean)) {
  const by = REVIEWERS[r.side].name
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
  blockingCount: confirmed.length,
  unverifiedCount: unverified.length,
  target: clip(target, 160),
  summaries,
  blocking: confirmed.map(full),
  unverified: unverified.map(full),
  advisory: advisoryList(advisory),
  rejected: rejected.map(f => clip(`${f.location}: ${f.problem} — refuted: ${f.reason}`, 160)).slice(0, 3),
  rejectedCount: rejected.length,
  next: nextStep(passed),
})
// Only complete, passing, whole-change full reviews are eligible for reuse.
if (passed && !since && !prior && input.headSha && input.baseSha) verdict.reviewCacheKey = cacheKey
return verdict
