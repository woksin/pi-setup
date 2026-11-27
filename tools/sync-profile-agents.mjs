#!/usr/bin/env node
// Rewrites agent/profiles/<name>/agents/<agent>.md from the base agent/agents/<agent>.md so every published
// profile carries the current agent bodies, extension lists (kill-guard) and subagent rules. Only what makes a
// profile a profile survives: its frontmatter `model:` and `thinking:` lines and, when the description names the
// model in a parenthetical such as "(Claude Opus 5.5, medium)", that parenthetical. Agents absent in the base are skipped.
//   node tools/sync-profile-agents.mjs          rewrite the profile copies
//   node tools/sync-profile-agents.mjs --check  fail if any copy is stale
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseDir = path.join(root, 'agent/agents')
const profilesDir = path.join(root, 'agent/profiles')
const check = process.argv.includes('--check')

/** Splits `---\nfrontmatter\n---\nbody`; the frontmatter is returned as lines. */
function split(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*|)$/.exec(text)
  if (!m) throw new Error('no frontmatter')
  return { lines: m[1].split(/\r?\n/), rest: m[2] }
}
const field = (lines, key) => lines.findIndex(l => l.startsWith(`${key}:`))
const PAREN = /\([^)]*\)/

export function render(baseText, profileText) {
  const base = split(baseText)
  const profile = split(profileText)
  const lines = [...base.lines]
  for (const key of ['model', 'thinking']) {
    const at = field(lines, key)
    const from = field(profile.lines, key)
    if (from < 0) { if (at >= 0) lines.splice(at, 1); continue }
    if (at >= 0) lines[at] = profile.lines[from]
    else lines.splice(Math.max(field(lines, 'description') + 1, 1), 0, profile.lines[from])
  }
  const bd = field(lines, 'description')
  const pd = field(profile.lines, 'description')
  if (bd >= 0 && pd >= 0) {
    const bp = PAREN.exec(lines[bd])
    const pp = PAREN.exec(profile.lines[pd])
    if (bp && pp) lines[bd] = lines[bd].replace(PAREN, () => pp[0])
    else if (bp && !pp) lines[bd] = profile.lines[pd]
  }
  return `---\n${lines.join('\n')}\n---${base.rest}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stale = []
  for (const profile of fs.readdirSync(profilesDir)) {
    const dir = path.join(profilesDir, profile, 'agents')
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const baseFile = path.join(baseDir, file)
      if (!fs.existsSync(baseFile)) continue
      const target = path.join(dir, file)
      const next = render(fs.readFileSync(baseFile, 'utf8'), fs.readFileSync(target, 'utf8'))
      if (next === fs.readFileSync(target, 'utf8')) continue
      stale.push(path.relative(root, target))
      if (!check) fs.writeFileSync(target, next)
    }
  }
  if (check && stale.length) {
    console.error(`stale profile agents (run node tools/sync-profile-agents.mjs):\n  ${stale.join('\n  ')}`)
    process.exit(1)
  }
  console.log(check ? 'profile agents are current' : `rewrote ${stale.length} profile agent file(s)`)
}
