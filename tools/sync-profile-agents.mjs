#!/usr/bin/env node
// Rewrites agent/profiles/<name>/agents/<agent>.md from the base agent/agents/<agent>.md so every published
// profile carries the current agent bodies, extension lists (kill-guard) and subagent rules. Only what makes a
// profile a profile survives: its frontmatter `model:` and `thinking:` entries and, when the description names the
// model in a parenthetical such as "(Claude Opus 5.5, medium)", that parenthetical. Agents absent in the base are skipped.
// Every base agent/workflows/*.js is also copied verbatim into each profile that has a workflows/ directory.
//   node tools/sync-profile-agents.mjs          rewrite the profile copies
//   node tools/sync-profile-agents.mjs --check  fail if any copy is stale
// Options: --repo <dir> (default: this repository), --base <dir> (holds agents/ and workflows/; default <repo>/agent,
// where inputs must be git-tracked), --out <dir> (write the changed profile files under <dir>/<name>/... instead of in place).
// Inputs are regular files (no symlinks); profile files are only replaced when tracked. Everything is validated first,
// and nothing is written when any input is malformed.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY = /^(?:"((?:[^"\\]|\\.)+)"|'([^']+)'|([A-Za-z0-9_-]+))[ \t]*:(?:[ \t]|$)/

/** Splits `---\nfrontmatter\n---\nbody` into entries (a key line plus its indented continuation lines) and the body. */
export function parse(text, where = 'input') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*|)$/.exec(text)
  if (!m) throw new Error(`${where}: missing or unterminated frontmatter`)
  const entries = []
  for (const line of m[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) { if (entries.length) entries.at(-1).lines.push(line); continue }
    if (/^[ \t]/.test(line)) {
      if (!entries.length) throw new Error(`${where}: indented line before any key: ${line}`)
      entries.at(-1).lines.push(line)
      continue
    }
    const k = KEY.exec(line)
    if (!k) throw new Error(`${where}: malformed frontmatter line: ${line}`)
    const key = k[1] ?? k[2] ?? k[3]
    if (entries.some(e => e.key === key)) throw new Error(`${where}: duplicate frontmatter key ${key}`)
    entries.push({ key, lines: [line] })
  }
  return { entries, rest: m[2] }
}
const serialize = ({ entries, rest }) => `---\n${entries.flatMap(e => e.lines).join('\n')}\n---${rest}`
const find = (entries, key) => entries.findIndex(e => e.key === key)
const single = (entry, where) => {
  if (entry.lines.length > 1 && entry.lines.slice(1).some(l => l.trim() !== '')) throw new Error(`${where}: multi-line ${entry.key} is not supported`)
  return entry
}
// A parenthetical that can name a model: no quotes or backslashes, so it is safe inside any YAML scalar style.
const PAREN = /\([^)"'\\]*\)/

export function render(baseText, profileText, where = 'profile') {
  const base = parse(baseText, `base ${where}`)
  const profile = parse(profileText, where)
  const entries = base.entries.map(e => ({ key: e.key, lines: [...e.lines] }))
  for (const key of ['model', 'thinking']) {
    const at = find(entries, key)
    const from = find(profile.entries, key)
    if (at >= 0) single(entries[at], `base ${where}`)
    if (from >= 0) single(profile.entries[from], where)
    if (from < 0) { if (at >= 0) entries.splice(at, 1); continue }
    const copy = { key, lines: [...profile.entries[from].lines] }
    if (at >= 0) entries[at] = copy
    else entries.splice(Math.max(find(entries, 'description') + 1, 1), 0, copy)
  }
  const bd = find(entries, 'description')
  const pd = find(profile.entries, 'description')
  if (bd >= 0 && pd >= 0) {
    single(entries[bd], `base ${where}`); single(profile.entries[pd], where)
    const bp = PAREN.exec(entries[bd].lines[0])
    const pp = PAREN.exec(profile.entries[pd].lines[0])
    if (bp && pp) {
      entries[bd].lines[0] = entries[bd].lines[0].replace(PAREN, () => pp[0])
    } else if (bp && !pp) entries[bd] = { key: 'description', lines: [...profile.entries[pd].lines] }
  }
  return serialize({ entries, rest: base.rest })
}

function main(argv) {
  const opt = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1] }
  const check = argv.includes('--check')
  const repo = path.resolve(opt('--repo') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const customBase = opt('--base')
  const baseRoot = path.resolve(customBase ?? path.join(repo, 'agent'))
  const outRoot = opt('--out') ? path.resolve(opt('--out')) : path.join(repo, 'agent/profiles')
  const inPlace = outRoot === path.join(repo, 'agent/profiles')
  if (check && !inPlace) throw new Error('--check cannot be combined with --out')

  const tracked = new Set(execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean))
  const isRegular = file => { const st = fs.lstatSync(file, { throwIfNoEntry: false }); return !!st && st.isFile() && !st.isSymbolicLink() }
  const baseFiles = (sub, ext) => {
    const dir = path.join(baseRoot, sub)
    return fs.readdirSync(dir).filter(f => f.endsWith(ext)).filter(f => {
      const file = path.join(dir, f)
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink`)
      if (!isRegular(file)) return false
      return customBase !== undefined || tracked.has(path.relative(repo, file))
    })
  }
  const agents = baseFiles('agents', '.md')
  const workflows = baseFiles('workflows', '.js')

  const profilesDir = path.join(repo, 'agent/profiles')
  const plan = []
  for (const profile of fs.readdirSync(profilesDir)) {
    const trackedIn = sub => [...tracked].some(t => t.startsWith(`agent/profiles/${profile}/${sub}/`))
    const rel = (sub, file) => `agent/profiles/${profile}/${sub}/${file}`
    if (trackedIn('agents')) {
      for (const file of agents) {
        const target = path.join(profilesDir, profile, 'agents', file)
        if (!tracked.has(rel('agents', file))) continue
        if (!isRegular(target)) throw new Error(`${target} is not a regular file`)
        const current = fs.readFileSync(target, 'utf8')
        const next = render(fs.readFileSync(path.join(baseRoot, 'agents', file), 'utf8'), current, rel('agents', file))
        if (next !== current) plan.push({ rel: path.join(profile, 'agents', file), target, content: next })
      }
    }
    if (trackedIn('workflows')) {
      for (const file of workflows) {
        const target = path.join(profilesDir, profile, 'workflows', file)
        const exists = fs.lstatSync(target, { throwIfNoEntry: false })
        if (exists && (!tracked.has(rel('workflows', file)) || !isRegular(target))) continue
        const content = fs.readFileSync(path.join(baseRoot, 'workflows', file))
        if (exists && fs.readFileSync(target).equals(content)) continue
        plan.push({ rel: path.join(profile, 'workflows', file), target, content })
      }
    }
  }

  if (check) {
    if (plan.length) { console.error(`stale profile files (run node tools/sync-profile-agents.mjs):\n  ${plan.map(p => p.rel).join('\n  ')}`); process.exit(1) }
    console.log('profile agents are current')
    return
  }
  for (const item of plan) {
    const dest = inPlace ? item.target : path.join(outRoot, item.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, item.content)
  }
  console.log(`wrote ${plan.length} profile file(s)${plan.length ? `: ${plan.map(p => p.rel).join(', ')}` : ''}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (e) { console.error(`sync-profile-agents: ${e.message}`); process.exit(1) }
}
