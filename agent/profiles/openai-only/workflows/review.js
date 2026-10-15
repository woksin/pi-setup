export const meta = {
  name: 'review',
  description: 'OpenAI-only independent Sol/Astra review with adversarial cross-model verification',
  whenToUse: 'Review a whole change before merge; quick mode for iteration, deep mode for hard reasoning',
  phases: [
    { title: 'Review', detail: 'Sol and Astra review independently' },
    { title: 'Verify', detail: 'the other OpenAI model challenges blocking findings' },
  ],
}

// Cross-model, NOT cross-provider. All named agents are pinned to openai-codex.
// args: target (required), context, author (sol/astra; legacy gpt/claude accepted),
// quick, deep, since, prior, round (1..3), force. Quick mode requires author;
// legacy gpt/claude authors use Astra. Full mode always uses both models.
// Delta reviews require an earlier whole-change review in the same mode and prior findings.
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
const call = (side, text, schema, label, phaseName) => agent(text, {
  agentType: reviewers[side].agentType, effort: reviewers[side].effort,
  schema, label, phase: phaseName,
})
const advisoryText = f => `(${f.severity}) ${f.location}: ${f.problem}`
const next = passed => passed ? 'Passed; fix cheap advisory items in the same pass, not another round.'
  : round >= 3 ? 'Not passed at the cap; make a structural fix or ask the user.'
    : `Fix blockers and rerun with since, prior and round: ${round + 1}.`
phase('Review')
if (quick) {
  const side = input.author === 'astra' ? 'sol' : 'astra'
  const res = await call(side, prompt, FINDINGS, `review:${side}`, 'Review')
  if (!res) return { passed: false, mode: 'quick', error: 'Review failed.' }
  const blockers = res.findings.filter(blocking)
  return {
    mode: 'quick', round, passed: blockers.length === 0, reviewedBy: reviewers[side].name,
    diversity: 'OpenAI-only cross-model', summary: res.summary,
    blockingCount: blockers.length, blocking: blockers,
    advisory: res.findings.filter(f => !blocking(f)).map(advisoryText), next: next(blockers.length === 0),
  }
}
const sides = ['sol', 'astra']
const results = await pipeline(sides,
  side => call(side, prompt, FINDINGS, `review:${side}`, 'Review'),
  async (res, side) => {
    if (!res) return { side, failed: true }
    const claims = res.findings.map((f, index) => ({ ...f, index })).filter(blocking)
    if (!claims.length) return { side, ...res, verdicts: [] }
    const checker = other(side)
    const verified = await call(checker,
      `Try to REFUTE each blocking claim from ${reviewers[side].name} about ${target}.${context}${scope}${priorText}\n` +
      'Read the actual code independently. Return exactly one verdict per index: blocks if real and merge-blocking; not-blocking if real but minor, pre-existing or hypothetical; refuted only with positive evidence; uncertain if inaccessible or unresolved. Cite evidence in reason. Do not edit files.\n' +
      JSON.stringify(claims) + rubric,
      VERDICTS, `verify:${side}-by-${checker}`, 'Verify')
    return { side, ...res, verdicts: verified ? verified.verdicts : null }
  },
)
const confirmed = [], unverified = [], advisory = [], rejected = [], incomplete = [], summaries = []
results.forEach((res, index) => {
  const side = sides[index]
  const by = reviewers[side].name
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
const passed = !incomplete.length && !confirmed.length && !unverified.length
log(`${confirmed.length} blocking, ${unverified.length} unverified, ${advisory.length} advisory — ${passed ? 'PASSED' : 'NOT PASSED'}`)
return {
  mode: deep ? 'deep' : 'full', diversity: 'OpenAI-only cross-model', round, target, passed,
  complete: incomplete.length === 0, incomplete, summaries,
  blockingCount: confirmed.length, unverifiedCount: unverified.length,
  blocking: confirmed, unverified, advisory: advisory.map(advisoryText),
  rejectedCount: rejected.length, rejected: rejected.map(f => `${f.location}: ${f.reason}`), next: next(passed),
}
