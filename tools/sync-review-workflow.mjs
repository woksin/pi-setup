#!/usr/bin/env node
// Renders agent/profiles/<name>/workflows/review.js from agent/workflows/review.js (the source) and
// tools/review-profiles.json. Only the `profile:begin/end <block>` regions differ per profile.
//   node tools/sync-review-workflow.mjs          rewrite the profile copies
//   node tools/sync-review-workflow.mjs --check  fail if any copy (or the source's own blocks) is stale
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceFile = path.join(root, 'agent/workflows/review.js')
const config = JSON.parse(fs.readFileSync(path.join(root, 'tools/review-profiles.json'), 'utf8'))

const q = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const key = name => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : q(name))
const sideLine = side => `{ agentType: ${q(side.agentType)}, name: ${q(side.name)}${side.reviewEffort ? `, reviewEffort: ${q(side.reviewEffort)}` : ''} }`
const sideMap = sides => `{\n${Object.entries(sides).map(([k, v]) => `  ${key(k)}: ${sideLine(v)},`).join('\n')}\n}`

const blocks = p => ({
  summary: [...p.fullSummary, ' ', ...p.deepSummary].map(line => (line === ' ' ? ' *' : ` * ${line}`)).join('\n') + '\n',
  meta: [
    `  description: ${q(p.description)},`,
    `  whenToUse: ${q(p.whenToUse)},`,
    '  phases: [',
    ...p.phases.map(ph => `    { title: ${q(ph.title)}, detail: ${q(ph.detail)} },`),
    '  ],',
  ].join('\n') + '\n',
  routing: [
    '// Pinned models, not provider labels. Keep synchronized with agent frontmatter.',
    `const AGENT_MODELS = {\n${Object.entries(p.models).map(([k, v]) => `  ${key(k)}: ${q(v)},`).join('\n')}\n}`,
    '// Review sides in lane order; the first side is the default author side. Lane, security and verify labels derive from the keys.',
    `const ROUTING = ${sideMap(p.sides)}`,
    '// Sides that run on a different agent in deep mode.',
    `const DEEP_ROUTING = ${sideMap(p.deepSides)}`,
    `const QUICK_ROUTING = ${sideMap(p.quickSides)}`,
    '// Accepted args.author values -> the side that wrote the work.',
    `const AUTHOR_SIDES = { ${Object.entries(p.authors).map(([k, v]) => `${key(k)}: ${q(v)}`).join(', ')} }`,
    "// Who checks `side`'s findings when the work was written by `author` (outside deep mode); null = always the other side.",
    `const SAME_AUTHOR_VERIFIER = ${p.sameAuthorVerifier ? `{ side: ${q(p.sameAuthorVerifier.side)}, author: ${q(p.sameAuthorVerifier.author)}, agentType: ${q(p.sameAuthorVerifier.agentType)}, name: ${q(p.sameAuthorVerifier.name)} }` : 'null'}`,
  ].join('\n') + '\n',
})

const BLOCK = /^([ \t]*(?:\/\/|\*) profile:begin (\w+)\n)([\s\S]*?)(^[ \t]*(?:\/\/|\*) profile:end \2\n)/gm
const render = (text, profile) => {
  const rendered = blocks(profile)
  return text.replace(BLOCK, (_, begin, name, _body, end) => {
    if (!(name in rendered)) throw new Error(`unknown profile block ${name}`)
    return begin + rendered[name] + end
  })
}
const merge = (base, over) => ({ ...base, ...over })

const source = fs.readFileSync(sourceFile, 'utf8')
const targets = [[sourceFile, render(source, config.defaults)]]
for (const [name, over] of Object.entries(config.profiles)) {
  targets.push([path.join(root, 'agent/profiles', name, 'workflows/review.js'), render(source, merge(config.defaults, over))])
}
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  const help = args.length === 1 && (args[0] === '-h' || args[0] === '--help')
  ;(help ? console.log : console.error)('Usage: node tools/sync-review-workflow.mjs [--check]')
  process.exit(help ? 0 : 2)
}
const check = args[0] === '--check'
let stale = 0
for (const [file, text] of targets) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (current === text) continue
  if (check) { stale++; console.error(`stale: ${path.relative(root, file)}`) } else fs.writeFileSync(file, text)
}
if (check && stale) { console.error('Run: node tools/sync-review-workflow.mjs'); process.exit(1) }
