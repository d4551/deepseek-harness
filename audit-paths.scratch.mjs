import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = '/Users/brandon/Downloads/deepseek-harness'
const out = []
const say = (line) => out.push(line)

const raw = readFileSync(join(ROOT, 'tsconfig.base.json'), 'utf8')
const stripped = raw.replace(/^\s*\/\/.*$/gm, '')
const config = JSON.parse(stripped)
const paths = config.compilerOptions.paths

const keyRe = /^\s*"([^"]+)":/gm
const seen = new Map()
for (const m of raw.matchAll(keyRe)) {
  const k = m[1]
  if (k === 'compilerOptions' || k === 'paths') continue
  seen.set(k, (seen.get(k) ?? 0) + 1)
}
const dupes = [...seen.entries()].filter(([, n]) => n > 1)
say('DUPLICATE KEYS: ' + (dupes.length === 0 ? 'none' : JSON.stringify(dupes)))

const BEGIN = '      // BEGIN generated package aliases — bun run gen-tsconfig-paths'
const END = '      // END generated package aliases'
const beginIdx = raw.indexOf(BEGIN)
const endIdx = raw.indexOf(END)
const handWrittenText = raw.slice(0, beginIdx) + raw.slice(endIdx + END.length)
const genText = raw.slice(beginIdx, endIdx + END.length)
const keysOf = (text) => {
  const set = new Set()
  for (const m of text.matchAll(/^\s*"([^"]+)":/gm)) set.add(m[1])
  return set
}
const crossDup = [...keysOf(genText)].filter(k => keysOf(handWrittenText).has(k))
say('CROSS-REGION DUP KEYS: ' + (crossDup.length === 0 ? 'none' : JSON.stringify(crossDup)))

const missingTargets = []
for (const [key, targets] of Object.entries(paths)) {
  for (const t of targets) {
    if (t.includes('*')) continue
    if (!existsSync(resolve(ROOT, t))) missingTargets.push(`${key} -> ${t}`)
  }
}
say('MISSING TARGETS: ' + (missingTargets.length === 0 ? 'none' : '\n  ' + missingTargets.join('\n  ')))

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'lib', 'vendor', '.audit-tmp', 'snapshots', '.agents'])
const files = []
function walk(dir) {
  let entries = []
  if (existsSync(dir)) entries = readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (dir === ROOT && (e.name === 'python' || e.name === 'native' || e.name === 'website')) continue
      walk(p)
    } else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) {
      files.push(p)
    }
  }
}
walk(ROOT)

const specRe = /@deepseek-ai\/dsh-[A-Za-z0-9-]+(?:\/[A-Za-z0-9._/?-]+)?/g
const used = new Map()
for (const f of files) {
  if (!existsSync(f)) continue
  const text = readFileSync(f, 'utf8')
  const local = new Set()
  for (const m of text.matchAll(specRe)) local.add(m[0])
  for (const s of local) {
    const rec = used.get(s) ?? { count: 0, examples: [] }
    rec.count += 1
    if (rec.examples.length < 2) rec.examples.push(f.slice(ROOT.length + 1))
    used.set(s, rec)
  }
}

const bareTargets = new Map()
for (const [key, targets] of Object.entries(paths)) {
  if (key.includes('*') || key.includes('/')) continue
  const t = targets.find(t2 => !t2.includes('*'))
  if (t) bareTargets.set(key, resolve(ROOT, t))
}

const manifestCache = new Map()
function manifestFor(spec) {
  const base = bareTargets.get(spec)
  if (base === undefined) return null
  const pkgDir = join(base, '..')
  const mp = join(pkgDir, 'package.json')
  if (!existsSync(mp)) return null
  if (manifestCache.has(mp)) return manifestCache.get(mp)
  const parsed = JSON.parse(readFileSync(mp, 'utf8'))
  manifestCache.set(mp, parsed)
  return parsed
}

const problems = []
for (const [spec, rec] of used) {
  const parts = spec.split('/')
  const bare = parts.slice(0, 2).join('/')
  const sub = parts.slice(2).join('/')
  if (sub === '') {
    if (paths[bare] === undefined) problems.push(`${spec}: BARE NOT MAPPED (${rec.examples.join(', ')})`)
    continue
  }
  if (sub.startsWith('src/')) {
    const base = bareTargets.get(bare)
    const srcFile = base === undefined ? null : join(base, sub.slice(4))
    const exists = srcFile !== null && existsSync(srcFile)
    const mf = manifestFor(bare)
    const exportEntry = mf?.exports?.['./src/*']
    if (!exists) problems.push(`${spec}: SRC DEEP IMPORT, FILE MISSING: ${String(srcFile)} (exports ./src/*: ${JSON.stringify(exportEntry ?? null)})`)
    continue
  }
  const mapped = paths[spec]
  if (mapped !== undefined) {
    const bad = mapped.filter(t => t.includes('*') || !existsSync(resolve(ROOT, t)))
    if (bad.length > 0) problems.push(`${spec}: ALIAS TARGET MISSING/WILDCARD: ${mapped.join(', ')}`)
    continue
  }
  const wild = Object.entries(paths).find(([k]) => {
    if (!k.includes('*')) return false
    const re = new RegExp('^' + k.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '[^/]+') + '$')
    return re.test(spec)
  })
  if (wild !== undefined) continue
  const base = bareTargets.get(bare)
  const srcTs = base === undefined ? null : join(base, `${sub}.ts`)
  const srcIdx = base === undefined ? null : join(base, sub, 'index.ts')
  const hasSrcTs = srcTs !== null && existsSync(srcTs)
  const hasSrcIdx = srcIdx !== null && existsSync(srcIdx)
  const mf = manifestFor(bare)
  const exp = mf?.exports?.[`./${sub}`]
  const detail = `exports=${exp === undefined ? '(none)' : JSON.stringify(exp).slice(0, 120)} srcTs=${hasSrcTs} srcIdx=${hasSrcIdx}`
  if (hasSrcTs || hasSrcIdx) {
    problems.push(`${spec}: UNMAPPED SUBPATH WITH SOURCE COUNTERPART (${rec.examples.join(', ')}) ${detail}`)
  } else {
    problems.push(`${spec}: UNMAPPED SUBPATH, NO SOURCE COUNTERPART (${rec.examples.join(', ')}) ${detail}`)
  }
}

say('USED SPECIFIERS: ' + used.size)
say('PROBLEMS: ' + (problems.length === 0 ? 'none' : '\n  ' + problems.join('\n  ')))
process.stdout.write(out.join('\n') + '\n')
