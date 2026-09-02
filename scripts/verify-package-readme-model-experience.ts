/**
 * Doc-sync gate for package README Model Experience sections; validates audited classifications,
 * model/token/KV-cache fields, package-owned text blocks, generated-catalog links, and final-section
 * order. See the [Model Experience Agent Note](../.agents/notes/implemented/process/2026-07-12-package-model-experience-contract.md).
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { markdownHeadingLines, markdownProseLines, type MarkdownProseLine } from './markdown.ts'
import { NO_MODEL_EXPERIENCE_SECTION, SENTENCE_MODEL_EXPERIENCE } from './package-readme-model-experience.registries.ts'

const root = resolve(import.meta.dirname, '..')
const HEADING = '## Model Experience'
const LIMITATIONS_HEADING = '## Known Limitations and Deferred Work'
const [MODEL_VIEW_HEADING, TOKEN_EFFECT_HEADING, KV_CACHE_EFFECT_HEADING] = ['#### What the model sees', '#### Token effect', '#### KV Cache effect'] as const
const FIELD_HEADINGS = [MODEL_VIEW_HEADING, TOKEN_EFFECT_HEADING, KV_CACHE_EFFECT_HEADING] as const

interface Failure {
  path: string
  message: string
}

type Line = MarkdownProseLine

interface ModelExperienceEntry {
  heading: Line
  modelView: Line
  tokenEffect: Line
  kvCacheEffect: Line
  title: string
  modelViewVerbatimBlocks: number
  verbatimBlocks: number
}

interface ParsedField {
  value: Line
  verbatimBlocks: number
}

/** Validate H5-plus-markdown literals nested under one Model Experience field. */
function validateNestedVerbatim(raw: readonly string[], fragments: Set<string>): { blocks: number; error?: string } {
  let cursor = 0
  while (raw[cursor]?.trim().length === 0) cursor += 1
  if (cursor === raw.length) return { blocks: 0 }

  let blocks = 0
  while (true) {
    while (raw[cursor]?.trim().length === 0) cursor += 1
    if (cursor === raw.length) break
    if (!/^##### \S/.test(raw[cursor] ?? '')) {
      return { blocks, error: 'content after a field paragraph must be a titled H5 verbatim block' }
    }
    const title = (raw[cursor] as string).slice('##### '.length)
    const fragment = headingFragment(title)
    if (fragment.length === 0) return { blocks, error: 'verbatim H5 title must be non-empty' }
    if (fragments.has(fragment)) {
      return { blocks, error: `verbatim H5 title ${JSON.stringify(title)} is duplicated within its model-context entry` }
    }
    fragments.add(fragment)
    cursor += 1
    while (raw[cursor]?.trim().length === 0) cursor += 1
    if (raw[cursor] !== '```markdown') {
      return { blocks, error: 'each nested verbatim H5 requires an exact ```markdown fence' }
    }
    cursor += 1
    const contentStart = cursor
    while (cursor < raw.length && raw[cursor] !== '```') cursor += 1
    if (cursor === raw.length) return { blocks, error: 'unterminated nested ```markdown fence' }
    if (cursor === contentStart) return { blocks, error: 'nested ```markdown fence must not be empty' }
    cursor += 1
    blocks += 1
  }
  return { blocks }
}

/** GitHub-style fragment for the simple ASCII nested titles allowed by these rules. */
function headingFragment(title: string): string {
  return title.toLowerCase().replaceAll('`', '').replaceAll(/[^a-z0-9 _-]/g, '').trim().replaceAll(/\s+/g, '-')
}

/** A direct stable system-prompt contribution, as named by the README rules. */
function isDirectSystemPromptEntry(title: string): boolean {
  return /\bsystem prompt\b/i.test(title)
}

/** Anchored generated-catalog links in one model-view field. */
function toolCatalogLinkFragments(text: string): string[] {
  return [...text.matchAll(/\]\(\.\.\/\.\.\/\.\.\/docs\/tool-catalog\.md#([a-z0-9_-]+)\)/g)]
    .map(match => match[1] as string)
}

const toolCatalogFragments = new Set<string>()
for (const line of readFileSync(resolve(root, 'docs/tool-catalog.md'), 'utf8').split('\n')) {
  const title = /^## (.+)$/.exec(line)?.[1]
  if (title !== undefined) toolCatalogFragments.add(headingFragment(title))
}

const failures: Failure[] = []
const packageJsons = globSync('packages/*/*/package.json', { cwd: root }).map(path => path.split(sep).join('/')).sort()
const scannedPackages = new Set(packageJsons.map(path => path.slice(0, -'/package.json'.length)))
let structuredCount = 0, modelContextEntryCount = 0, omittedSectionCount = 0, explainedNoneCount = 0, indirectCount = 0
let verbatimBlockCount = 0, systemPromptEntryCount = 0, toolSchemaEntryCount = 0, kvCacheEffectCount = 0

for (const [pkg, reason] of Object.entries(NO_MODEL_EXPERIENCE_SECTION)) {
  if (!scannedPackages.has(pkg)) {
    failures.push({ path: `${pkg}/README.md`, message: 'no-section allowlist entry does not name a scanned package' })
  }
  if (reason.trim().length === 0) {
    failures.push({ path: `${pkg}/README.md`, message: 'no-section allowlist entry must retain its audit justification' })
  }
  if (SENTENCE_MODEL_EXPERIENCE[pkg] !== undefined) {
    failures.push({ path: `${pkg}/README.md`, message: 'package cannot appear in both Model Experience allowlists' })
  }
}

for (const [pkg, contract] of Object.entries(SENTENCE_MODEL_EXPERIENCE)) {
  if (!scannedPackages.has(pkg)) {
    failures.push({ path: `${pkg}/README.md`, message: 'sentence allowlist entry does not name a scanned package' })
  }
  if (contract.reason.trim().length === 0) {
    failures.push({ path: `${pkg}/README.md`, message: 'sentence allowlist entry must justify why structured model-context entries are unnecessary' })
  }
}

for (const packageJson of packageJsons) {
  const pkg = packageJson.slice(0, -'/package.json'.length)
  const readme = packageJson.replace(/package\.json$/, 'README.md')
  const abs = resolve(root, readme)
  if (!existsSync(abs)) {
    failures.push({ path: readme, message: 'missing package README' })
    continue
  }

  const text = readFileSync(abs, 'utf8')
  const rawLines = text.split('\n')
  const lines = markdownProseLines(text)
  const headings = markdownHeadingLines(text)
  const h2Headings = headings.filter(heading => heading.depth === 2)
  const modelExperienceHeadings = headings.filter(heading => heading.text
    .trim().replaceAll(/\s+/g, ' ').toLowerCase() === 'model experience')
  const modelHeadings = modelExperienceHeadings.filter(heading => heading.depth === 2 && heading.raw === HEADING)
  if (NO_MODEL_EXPERIENCE_SECTION[pkg] !== undefined) {
    if (modelExperienceHeadings.length !== 0) {
      for (const heading of modelExperienceHeadings) {
        failures.push({ path: readme, message: `line ${heading.index}: audited model-agnostic package must omit every Model Experience heading; found ${JSON.stringify(heading.raw)}` })
      }
    } else {
      omittedSectionCount += 1
    }
    continue
  }
  const nonCanonicalModelHeading = modelExperienceHeadings.find(heading => heading.depth !== 2 || heading.raw !== HEADING)
  if (nonCanonicalModelHeading !== undefined) {
    failures.push({ path: readme, message: `line ${nonCanonicalModelHeading.index}: non-canonical Model Experience heading ${JSON.stringify(nonCanonicalModelHeading.raw)}; use exactly ${JSON.stringify(HEADING)}` })
    continue
  }
  const modelHeading = modelHeadings.at(0)
  if (modelHeading === undefined) {
    failures.push({
      path: readme,
      message: `missing ${HEADING}`,
    })
    continue
  }
  if (modelHeadings.length !== 1) {
    failures.push({ path: readme, message: `contains ${modelHeadings.length} copies of ${HEADING}` })
    continue
  }
  const modelH2Index = h2Headings.indexOf(modelHeading)
  const limitationsH2Index = h2Headings.findIndex(heading => heading.depth === 2 && heading.raw === LIMITATIONS_HEADING)
  if (limitationsH2Index >= 0) {
    if (modelH2Index !== h2Headings.length - 2 || limitationsH2Index !== h2Headings.length - 1) {
      failures.push({
        path: readme,
        message: `${HEADING} and ${LIMITATIONS_HEADING} must be the final two H2 sections, in that order`,
      })
      continue
    }
  } else if (modelH2Index !== h2Headings.length - 1) {
    failures.push({ path: readme, message: `${HEADING} must be the final H2 when ${LIMITATIONS_HEADING} is absent` })
    continue
  }

  const modelHeadingAt = lines.findIndex(line => line.index === modelHeading.index)
  const body = lines.slice(modelHeadingAt + 1)
  const h2Lines = new Set(h2Headings.map(heading => heading.index))
  const nextH2 = body.findIndex(line => h2Lines.has(line.index))
  const section = nextH2 < 0 ? body : body.slice(0, nextH2)
  const nextH2Line = nextH2 < 0 ? rawLines.length + 1 : (body[nextH2] as Line).index
  const rawSection = rawLines.slice(modelHeading.index, nextH2Line - 1)
  const content = section.filter(line => line.raw.trim().length > 0)
  const sentenceContract = SENTENCE_MODEL_EXPERIENCE[pkg]
  if (sentenceContract !== undefined) {
    const pattern = sentenceContract.kind === 'none' ? /^None, as .+\.$/ : /^Indirectly, through .+\.$/
    const rawContent = rawSection.filter(line => line.trim().length > 0)
    const sentence = content[0]
    const kvCacheHeading = content[1]
    const kvCacheEffect = content[2]
    if (content.length !== 3 || rawContent.length !== 3 || !pattern.test(sentence?.raw ?? '')) {
      const prefix = sentenceContract.kind === 'none' ? 'None, as ' : 'Indirectly, through '
      failures.push({ path: readme, message: `must contain exactly one sentence beginning ${JSON.stringify(prefix)} and ending with a period, followed by ${KV_CACHE_EFFECT_HEADING} and one non-empty paragraph` })
      continue
    }
    if (kvCacheHeading?.raw !== KV_CACHE_EFFECT_HEADING
      || kvCacheEffect === undefined
      || /^#{1,6} /.test(kvCacheEffect.raw)
      || kvCacheEffect.raw.trim().length === 0) {
      failures.push({ path: readme, message: `line ${kvCacheHeading?.index ?? sentence?.index ?? modelHeading.index}: short Model Experience form requires exact ${KV_CACHE_EFFECT_HEADING} and one non-empty paragraph` })
      continue
    }
    if (sentence === undefined
      || sentence.index !== modelHeading.index + 2
      || kvCacheHeading.index !== sentence.index + 2
      || kvCacheEffect.index !== kvCacheHeading.index + 2) {
      failures.push({ path: readme, message: 'short Model Experience sentence, KV-cache H4, and paragraph require one blank line between each element' })
      continue
    }
    if (sentenceContract.kind === 'none') explainedNoneCount += 1
    else indirectCount += 1
    kvCacheEffectCount += 1
    continue
  }

  const shortSentence = content.find(line => line.raw === 'None.' || /^None, as |^Indirectly, through /.test(line.raw))
  if (shortSentence !== undefined) {
    failures.push({ path: readme, message: `line ${shortSentence.index}: short Model Experience form requires an audited entry in SENTENCE_MODEL_EXPERIENCE` })
    continue
  }

  const entryStarts = content
    .map((line, index) => ({ line, index }))
    .filter(entry => /^### \S/.test(entry.line.raw))
  if (entryStarts.length === 0 || entryStarts[0]?.index !== 0) {
    failures.push({ path: readme, message: 'must contain one or more complete model-context entries' })
    continue
  }

  const modelContextEntries: ModelExperienceEntry[] = []
  const entryFragments = new Set<string>()
  let entryError = false
  for (let entryIndex = 0; entryIndex < entryStarts.length; entryIndex += 1) {
    const start = entryStarts[entryIndex] as { line: Line; index: number }
    const end = entryStarts[entryIndex + 1]?.index ?? content.length
    const entries = content.slice(start.index, end)
    const heading = entries[0] as Line
    const title = heading.raw.slice('### '.length)
    const fragment = headingFragment(title)
    if (fragment.length === 0) {
      failures.push({ path: readme, message: `line ${heading.index}: each model-context entry requires a non-empty H3 heading` })
      entryError = true
      break
    }
    if (entryFragments.has(fragment)) {
      failures.push({ path: readme, message: `line ${heading.index}: duplicate model-context entry link fragment ${JSON.stringify(fragment)}` })
      entryError = true
      break
    }
    const fieldStarts = entries
      .map((line, index) => ({ line, index }))
      .filter(entry => /^#### \S/.test(entry.line.raw))
    if (fieldStarts.length !== FIELD_HEADINGS.length || fieldStarts[0]?.index !== 1) {
      failures.push({ path: readme, message: `line ${heading.index}: model-context entry requires exactly three ordered H4 fields: ${FIELD_HEADINGS.join(', ')}` })
      entryError = true
      break
    }
    if ((entryIndex === 0 && heading.index !== modelHeading.index + 2)
      || rawLines[heading.index - 2]?.trim().length !== 0
      || fieldStarts[0].line.index !== heading.index + 2) {
      failures.push({ path: readme, message: `line ${heading.index}: model-context entry heading and first field require one blank line between them` })
      entryError = true
      break
    }
    const parsedFields: ParsedField[] = []
    const verbatimFragments = new Set<string>()
    for (let fieldIndex = 0; fieldIndex < FIELD_HEADINGS.length; fieldIndex += 1) {
      const fieldStart = fieldStarts[fieldIndex] as { line: Line; index: number }
      const expectedHeading = FIELD_HEADINGS[fieldIndex] as string
      if (fieldStart.line.raw !== expectedHeading) {
        failures.push({ path: readme, message: `line ${fieldStart.line.index}: expected exact field heading ${JSON.stringify(expectedHeading)}, found ${JSON.stringify(fieldStart.line.raw)}` })
        entryError = true
        break
      }
      const fieldEnd = fieldStarts[fieldIndex + 1]?.index ?? entries.length
      const fieldEntries = entries.slice(fieldStart.index, fieldEnd)
      const value = fieldEntries[1]
      if (value === undefined || /^#{1,6} /.test(value.raw) || value.raw.trim().length === 0) {
        failures.push({ path: readme, message: `line ${fieldStart.line.index}: ${expectedHeading} requires one non-empty paragraph` })
        entryError = true
        break
      }
      if (value.index !== fieldStart.line.index + 2) {
        failures.push({ path: readme, message: `line ${fieldStart.line.index}: ${expectedHeading} and its paragraph require one blank line between them` })
        entryError = true
        break
      }
      const unexpected = fieldEntries.slice(2).find(line => !/^##### \S/.test(line.raw))
      if (unexpected !== undefined) {
        failures.push({ path: readme, message: `line ${unexpected.index}: content after ${expectedHeading} paragraph must be a titled H5 plus \`markdown\` fence owned by that field` })
        entryError = true
        break
      }
      const nextHeadingLine = fieldStarts[fieldIndex + 1]?.line.index
        ?? entryStarts[entryIndex + 1]?.line.index
        ?? nextH2Line
      if (rawLines[nextHeadingLine - 2]?.trim().length !== 0) {
        failures.push({ path: readme, message: `line ${nextHeadingLine}: Model Experience headings require a preceding blank line` })
        entryError = true
        break
      }
      const verbatim = validateNestedVerbatim(rawLines.slice(value.index, nextHeadingLine - 1), verbatimFragments)
      if (verbatim.error !== undefined) {
        failures.push({ path: readme, message: `line ${value.index}: ${verbatim.error}` })
        entryError = true
        break
      }
      if (fieldEntries.length - 2 !== verbatim.blocks) {
        failures.push({ path: readme, message: `line ${value.index}: every nested H5 must own exactly one \`markdown\` fence` })
        entryError = true
        break
      }
      parsedFields.push({ value, verbatimBlocks: verbatim.blocks })
    }
    if (entryError) break
    const modelViewField = parsedFields[0] as ParsedField
    const tokenEffectField = parsedFields[1] as ParsedField
    const kvCacheEffectField = parsedFields[2] as ParsedField
    const modelView = modelViewField.value
    const tokenEffect = tokenEffectField.value
    const kvCacheEffect = kvCacheEffectField.value
    if (/\]\(#[^)]+\)/.test(modelView.raw) || /\]\(#[^)]+\)/.test(tokenEffect.raw) || /\]\(#[^)]+\)/.test(kvCacheEffect.raw)) {
      failures.push({ path: readme, message: `line ${heading.index}: Model Experience fields must not link between local subsections; nest the H5 in its owning H4 field` })
      entryError = true
      break
    }
    entryFragments.add(fragment)
    modelContextEntries.push({
      heading,
      modelView,
      tokenEffect,
      kvCacheEffect,
      title,
      modelViewVerbatimBlocks: modelViewField.verbatimBlocks,
      verbatimBlocks: parsedFields.reduce((total, field) => total + field.verbatimBlocks, 0),
    })
  }
  if (entryError) continue

  const promptWithoutVerbatim = modelContextEntries.find(entry => isDirectSystemPromptEntry(entry.title)
    && entry.modelViewVerbatimBlocks === 0)
  if (promptWithoutVerbatim !== undefined) {
    failures.push({ path: readme, message: `line ${promptWithoutVerbatim.heading.index}: system-prompt entry must contain a titled H5 plus verbatim \`markdown\` block under ${MODEL_VIEW_HEADING}` })
    continue
  }
  const hasConcreteLiteral = modelContextEntries.some(entry => entry.verbatimBlocks > 0
    || entry.modelView.raw.includes('`')
    || entry.tokenEffect.raw.includes('`')
    || toolCatalogLinkFragments(entry.modelView.raw).length > 0)
  if (!hasConcreteLiteral) {
    failures.push({ path: readme, message: 'structured Model Experience must ground at least one entry with inline code, a nested `markdown` block, or an anchored tool-catalog link' })
    continue
  }
  let catalogError = false
  for (const entry of modelContextEntries) {
    if (!/\bschemas?\b/i.test(entry.title)) continue
    const fragments = toolCatalogLinkFragments(entry.modelView.raw)
    if (fragments.length === 0) {
      failures.push({ path: readme, message: `line ${entry.heading.index}: tool-schema entry must link an anchored section of ../../../docs/tool-catalog.md` })
      catalogError = true
      break
    }
    const invalid = fragments.find(fragment => !toolCatalogFragments.has(fragment))
    if (invalid !== undefined) {
      failures.push({ path: readme, message: `line ${entry.modelView.index}: tool-catalog link fragment ${JSON.stringify(invalid)} does not name an H2 section` })
      catalogError = true
      break
    }
  }
  if (catalogError) continue
  verbatimBlockCount += modelContextEntries.reduce((total, entry) => total + entry.verbatimBlocks, 0)
  modelContextEntryCount += modelContextEntries.length
  systemPromptEntryCount += modelContextEntries.filter(entry => isDirectSystemPromptEntry(entry.title)).length
  toolSchemaEntryCount += modelContextEntries.filter(entry => /\bschemas?\b/i.test(entry.title)).length
  kvCacheEffectCount += modelContextEntries.length
  structuredCount += 1
}

if (failures.length === 0) {
  process.stdout.write(`verify-package-readme-model-experience: ${packageJsons.length} README(s) checked (${omittedSectionCount} audited omissions, ${structuredCount} structured, ${modelContextEntryCount} model-context entries, ${kvCacheEffectCount} KV-cache fields, ${systemPromptEntryCount} fenced system-prompt entries, ${toolSchemaEntryCount} catalog-linked tool-schema entries, ${explainedNoneCount} explained none, ${indirectCount} indirect, ${verbatimBlockCount} verbatim markdown blocks), all conform.\n`)
  process.exit(0)
}

process.stderr.write('verify-package-readme-model-experience failed:\n')
for (const failure of failures) {
  process.stderr.write(`  ${relative(root, resolve(root, failure.path))}: ${failure.message}\n`)
}
process.exit(1)
