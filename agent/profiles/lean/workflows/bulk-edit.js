/**
 * bulk-edit.js — apply one mechanical change across many files cheaply, then prove it.
 *
 * Each file is edited by its own `grunt` agent (GPT-6 Luna), one file per agent, so
 * agents never touch the same file. If a gate command is given it must pass afterwards;
 * if it fails, the `implementer` (GPT-6.1 Sol) fixes the fallout under the same gate.
 *
 * args: {
 *   instructions: string    — the exact mechanical change to apply to each file
 *   files?:       string[]  — files to edit (preferred: explicit list)
 *   find?:        string    — if no files given: description of which files to find (Explore agent lists them)
 *   gate?:        string    — command that must pass afterwards, e.g. "npm test" or "dotnet build"
 * }
 *
 * Run: "run bulk-edit: rename FooService to BarService in these files …, gate npm run build"
 */
export const meta = {
  name: 'bulk-edit',
  description: 'Apply one mechanical change across many files with cheap GPT-6 Luna agents, then verify with a gate command',
  whenToUse: 'Renames, boilerplate or pattern changes across many files that need no judgment per file',
  phases: [
    { title: 'Discover', detail: 'list target files if none were given' },
    { title: 'Edit', detail: 'one grunt (GPT-6 Luna) per file' },
    { title: 'Verify', detail: 'run the gate command' },
    { title: 'Fix', detail: 'implementer (GPT-6.1 Sol) fixes gate failures' },
  ],
}

// The SubagentWorkflow tool can deliver args as a JSON string rather than an object.
const input = typeof args === "string" ? JSON.parse(args) : args

const instructions = input?.instructions
if (!instructions) return { error: 'Missing args.instructions — the exact change to apply.' }
const gate = input?.gate

let files = Array.isArray(input?.files) ? input.files : []

if (files.length === 0) {
  if (!input?.find) return { error: 'Give args.files (preferred) or args.find (which files to look for).' }
  phase('Discover')
  const found = await agent(
    `List every file that matches this description: ${input.find}\n` +
      `They will receive this change: ${instructions}\n` +
      'Return repository-relative paths only. Include a file only if the change applies to it.',
    {
      agentType: 'Explore',
      label: 'discover',
      phase: 'Discover',
      schema: {
        type: 'object',
        properties: { files: { type: 'array', items: { type: 'string' } } },
        required: ['files'],
      },
    },
  )
  files = found ? found.files : []
}

files = [...new Set(files)]
if (files.length === 0) return { error: 'No files to edit.' }
log(`Editing ${files.length} file(s)`)

phase('Edit')
const EDIT = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    changed: { type: 'boolean' },
    notes: { type: 'string', description: 'What changed, or why nothing/partly changed' },
  },
  required: ['file', 'changed', 'notes'],
}

const edits = await pipeline(files, file =>
  agent(
    `Apply this change to ${file} ONLY. Do not modify any other file.\n\nChange:\n${instructions}\n\n` +
      'If the change does not apply to this file, or needs a judgment call, change nothing and explain in notes.',
    { agentType: 'grunt', schema: EDIT, label: `edit:${file}`, phase: 'Edit' },
  ),
)

const changed = []
const unchanged = []
const failed = []
edits.forEach((e, i) => {
  if (!e) failed.push(files[i])
  else if (e.changed) changed.push({ file: files[i], notes: e.notes })
  else unchanged.push({ file: files[i], notes: e.notes })
})
log(`${changed.length} changed, ${unchanged.length} unchanged, ${failed.length} failed`)

if (!gate) {
  log('No gate command given — edits are NOT verified')
  return { changed, unchanged, failed, gate: null, passed: null }
}

phase('Verify')
const verified = await agent(`Run \`${gate}\` and report the result. Change nothing.`, {
  agentType: 'grunt',
  label: 'verify',
  phase: 'Verify',
  gate,
})
if (verified !== null) return { changed, unchanged, failed, gate, passed: true }

phase('Fix')
log(`${gate} failed after the edits — handing to implementer`)
const fixed = await agent(
  `\`${gate}\` fails after a bulk edit. The intended change was:\n${instructions}\n\n` +
    `Files edited: ${changed.map(c => c.file).join(', ') || '(none reported)'}\n\n` +
    `Run \`${gate}\`, find the failures caused by the edit, and fix them without reverting the intended change. ` +
    'If the failures are unrelated to the edit, change nothing and report that.',
  { agentType: 'implementer', label: 'fix', phase: 'Fix', gate },
)

return { changed, unchanged, failed, gate, passed: fixed !== null, fixSummary: fixed }
