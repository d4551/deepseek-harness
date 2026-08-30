/**
 * Verify every `ts type-equiv` and `ts public-api` block against the source
 * symbol named by the manifest. Ordinary entries preserve the complete
 * declaration; `public-api` entries preserve a class's body-stripped public
 * declaration. Blocks and entries have a one-to-one relationship; comparison
 * ignores whitespace and non-JSDoc comments but preserves declaration
 * structure and every original JSDoc comment. Byte-identical `.zh.md` blocks
 * reuse the manifest-backed check of their unsuffixed sibling.
 */

import { globSync, readFileSync, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { markdownFences } from './markdown.ts'
import { partitionPairedMarkdownDerivatives } from './paired-markdown-derivatives.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'
import { readConfigFile } from './ts7-session.ts'
import {
  blockSymbol,
  mergedInterfaceDeclaration,
  sourceDeclaration,
  sourcePublicApi,
  stripExport,
} from './verify-type-equiv-source.ts'

const root = resolve(import.meta.dirname, '..')
const MARKDOWN_GLOBS = ['README.md', '.agents/notes/**/*.md', 'docs/**/*.md', 'packages/*/*.md', 'packages/*/*/*.md']

interface ManifestEntry {
  doc: string
  symbol: string
  source: string
  augmentations?: Array<{ source: string; module: string }>
  projection?: 'public-api'
}

interface EquivBlock {
  doc: string
  line: number
  symbol: string
  projection?: 'public-api'
  code: string
}

function normalizeStructure(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeJSDoc(code: string): string[] {
  return [...code.matchAll(/\/\*\*[\s\S]*?\*\//g)]
    .map(match => match[0].replace(/\s+/g, ' ').trim())
}

function extractEquivBlocks(docRel: string): EquivBlock[] {
  const blocks: EquivBlock[] = []
  for (const fence of markdownFences(readFileSync(resolve(root, docRel), 'utf8'))) {
    if (fence.info === 'ts type-equiv public-api') {
      throw new Error(`verify-type-equiv: ${docRel}:${String(fence.line)} — use the concise \`ts public-api\` fence`)
    }
    if (fence.info !== 'ts type-equiv' && fence.info !== 'ts public-api') continue
    if (!fence.closed) {
      throw new Error(`verify-type-equiv: ${docRel}:${String(fence.line)} — unterminated type-equivalence fence (missing closing \`\`\`)`)
    }
    const symbol = blockSymbol(fence.code)
    if (symbol === null) {
      throw new Error(`verify-type-equiv: ${docRel}:${String(fence.line)} — type-equiv block has no parseable interface/type/class declaration`)
    }
    blocks.push({
      doc: docRel,
      line: fence.line,
      symbol,
      code: fence.code,
      ...fence.info === 'ts public-api' ? { projection: 'public-api' as const } : {},
    })
  }
  return blocks
}

function readManifestEntries(): ManifestEntry[] {
  const parsed = readConfigFile(resolve(root, 'scripts/type-equiv.manifest.json'))
  if (parsed.error !== undefined) throw new Error(`verify-type-equiv: ${parsed.error.messageText}`)
  const config = parsed.config
  if (config === null || typeof config !== 'object' || Array.isArray(config) || !('entries' in config)) {
    throw new Error('verify-type-equiv: manifest has no entries array')
  }
  const entries: unknown = Reflect.get(config, 'entries')
  if (!Array.isArray(entries)) throw new Error('verify-type-equiv: manifest has no entries array')
  // The manifest is a repository-owned file; its rows are read as declared.
  return entries as ManifestEntry[]
}

const entries = readManifestEntries()
const keyOf = (x: { doc: string; symbol: string; projection?: 'public-api' }): string =>
  `${x.doc}::${x.symbol}::${x.projection ?? 'declaration'}`

const docSet = new Set<string>()
for (const pattern of MARKDOWN_GLOBS) {
  for (const match of globSync(pattern, { cwd: root })) {
    const normalized = match.split(sep).join('/')
    if (!isArchivedAgentNotePath(normalized)) docSet.add(normalized)
  }
}
const extractedBlocks: EquivBlock[] = [...docSet].sort().flatMap(extractEquivBlocks)
const { primary: blocks, derivatives } = partitionPairedMarkdownDerivatives(
  extractedBlocks,
  block => block.doc,
  block => `${block.projection ?? 'declaration'}\0${block.code}`,
)

const errors: string[] = []
for (const d of [...new Set(entries.map(e => e.doc))]) {
  if (!existsSync(resolve(root, d))) errors.push(`manifest references ${d}, which does not exist`)
  else if (!docSet.has(d)) errors.push(`manifest references ${d}, which is outside the scanned markdown scope (${MARKDOWN_GLOBS.join(', ')})`)
}

const blockByKey = new Map<string, EquivBlock>()
for (const b of blocks) {
  const k = keyOf(b)
  const prior = blockByKey.get(k)
  if (prior) {
    errors.push(`duplicate type-equiv block for ${b.symbol} in ${b.doc} (lines ${String(prior.line)} and ${String(b.line)})`)
    continue
  }
  blockByKey.set(k, b)
}

const entryByKey = new Map<string, ManifestEntry>()
for (const e of entries) {
  const k = keyOf(e)
  if (entryByKey.has(k)) {
    errors.push(`duplicate manifest entry for ${e.symbol} in ${e.doc}`)
    continue
  }
  entryByKey.set(k, e)
}

for (const b of blocks) {
  if (!entryByKey.has(keyOf(b))) {
    errors.push(`type-equiv block ${b.symbol} (${b.doc}:${String(b.line)}) has no manifest entry — add one to scripts/type-equiv.manifest.json`)
  }
}
for (const e of entries) {
  if (!blockByKey.has(keyOf(e))) {
    errors.push(`manifest entry ${e.symbol} (${e.doc}) has no matching type-equiv block — remove it or add the block`)
  }
}

let verified = 0
for (const e of entries) {
  const b = blockByKey.get(keyOf(e))
  if (!b) continue
  const decl = e.augmentations !== undefined
    ? mergedInterfaceDeclaration(e)
    : e.projection === 'public-api'
      ? sourcePublicApi(e.source, e.symbol)
      : sourceDeclaration(e.source, e.symbol)
  if (decl === null) {
    errors.push(`symbol ${e.symbol} not found in ${e.source} (manifest entry for ${e.doc})`)
    continue
  }
  const doc = stripExport(b.code)
  const sourceStructure = normalizeStructure(decl)
  const docStructure = normalizeStructure(doc)
  const sourceDocs = normalizeJSDoc(decl)
  const docJSDoc = normalizeJSDoc(doc)
  if (sourceStructure !== docStructure || JSON.stringify(sourceDocs) !== JSON.stringify(docJSDoc)) {
    errors.push(
      `DRIFT: ${e.doc}:${String(b.line)} — type-equiv block for ${e.symbol} does not match ${e.source}.\n`
      + `    source structure: ${sourceStructure}\n`
      + `    doc structure:    ${docStructure}\n`
      + `    source JSDoc:     ${JSON.stringify(sourceDocs)}\n`
      + `    doc JSDoc:        ${JSON.stringify(docJSDoc)}`,
    )
    continue
  }
  verified += 1
}

if (errors.length === 0) {
  process.stdout.write(`verify-type-equiv: ${String(verified)} type-equiv block(s) match source structure and JSDoc (1:1 with manifest); ${String(derivatives.length)} paired derivative(s).\n`)
  process.exit(0)
}

process.stderr.write('verify-type-equiv: type-equiv verification failed:\n')
for (const e of errors) process.stderr.write(`  ${e}\n`)
process.stderr.write(`\n(checked ${String(blocks.length)} primary block(s) across ${String(new Set(blocks.map(b => b.doc)).size)} doc(s), ${String(derivatives.length)} paired derivative(s); manifest at scripts/type-equiv.manifest.json)\n`)
process.exit(1)
