/** Generate detailed Cordis core API pages from pinned vendor declarations. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  ClassDeclaration, ClassElement, GetAccessorDeclaration, InterfaceDeclaration, MethodDeclaration,
  MethodSignatureDeclaration, Node, ParameterDeclaration, PropertyDeclaration, PropertySignatureDeclaration,
  SourceFile, TypeNode,
} from 'typescript/unstable/ast'
import { ModifierFlags } from 'typescript/unstable/ast'
import {
  isClassDeclaration, isComputedPropertyName, isConstructorDeclaration, isEnumDeclaration,
  isFunctionDeclaration, isGetAccessorDeclaration, isIdentifier, isInterfaceDeclaration,
  isLiteralTypeNode, isMethodDeclaration, isMethodSignatureDeclaration, isModuleDeclaration,
  isPrivateIdentifier, isPropertyDeclaration, isPropertySignatureDeclaration, isSetAccessorDeclaration,
  isStringLiteral, isTypeAliasDeclaration, isTypeReferenceNode, isUnionTypeNode,
} from 'typescript/unstable/ast/is'
import { checkParams, checkReturns, parseJsDoc, parseTags, pointer, rawJsDoc, reportViolations } from './jsdoc.ts'
import { cordisModuleBody } from './cordis-walk.ts'
import {
  CORDIS_CORE_API_PAGES as PAGE_TABLE,
  type CordisCoreApiPage as Page,
  type CordisCoreApiSection as Section,
} from './cordis-core-api-pages.ts'
import { parsePath } from './ts7-session.ts'

export const CORDIS_CORE_API_PAGES = PAGE_TABLE
export type CordisCoreApiPage = Page
export type CordisCoreApiSection = Section

const root = resolve(import.meta.dirname, '..')
const FENCE = 'ts cordis-catalog'

interface MemberDoc {
  name: string
  heading: string
  signatures: string[]
  jsDoc: string
  doc: string
  params: { name: string; text: string }[]
  returns: string | null
  source: string
}

interface RenderContext {
  scanRoot: string
  cache: Map<string, { sf: SourceFile; text: string }>
  violations: string[]
}

type Member = MethodDeclaration | MethodSignatureDeclaration | PropertyDeclaration
  | PropertySignatureDeclaration | GetAccessorDeclaration

function load(ctx: RenderContext, rel: string): { sf: SourceFile; text: string } {
  const cached = ctx.cache.get(rel)
  if (cached !== undefined) return cached
  const text = readFileSync(resolve(ctx.scanRoot, rel), 'utf8')
  const entry = { sf: parsePath(resolve(ctx.scanRoot, rel)), text }
  ctx.cache.set(rel, entry)
  return entry
}

function sourceJsDoc(text: string, sf: SourceFile, node: Node): string {
  const raw = rawJsDoc(text, node)
  if (raw === '') return ''
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  const lineStart = sf.getPositionOfLineAndCharacter(line, 0)
  const indent = text.slice(lineStart, node.getStart(sf))
  return raw.split('\n')
    .map((sourceLine, index) => index > 0 && sourceLine.startsWith(indent)
      ? sourceLine.slice(indent.length)
      : sourceLine)
    .join('\n')
}

function signatureOf(member: Node, sf: SourceFile): string {
  const full = member.getText(sf)
  let tail: Node | undefined
  if (isMethodDeclaration(member) || isGetAccessorDeclaration(member)) tail = member.body
  else if (isPropertyDeclaration(member)) tail = member.initializer
  const signature = tail === undefined
    ? full
    : full.slice(0, full.length - tail.getText(sf).length).replace(/[=\s]+$/, '')
  return signature.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
}

function headingParams(parameters: readonly ParameterDeclaration[], sf: SourceFile): string {
  const names = parameters
    .filter(parameter => !(isIdentifier(parameter.name) && parameter.name.text === 'this'))
    .map((parameter) => {
      const rest = parameter.dotDotDotToken ? '...' : ''
      const optional = parameter.questionToken || parameter.initializer ? '?' : ''
      return `${rest}${parameter.name.getText(sf)}${optional}`
    })
  return `(${names.join(', ')})`
}

function flagsOf(member: ClassElement): number {
  if (!('modifierFlags' in member)) return 0
  const flags = member.modifierFlags
  return typeof flags === 'number' ? flags : 0
}

function isPublicInstance(member: ClassElement): boolean {
  const modifiers = flagsOf(member)
  if (modifiers & (ModifierFlags.Private | ModifierFlags.Protected | ModifierFlags.Static)) return false
  if (isMethodDeclaration(member) || isPropertyDeclaration(member) || isGetAccessorDeclaration(member)) {
    if (isComputedPropertyName(member.name) || isPrivateIdentifier(member.name)) return false
    return !member.name.getText().startsWith('_')
  }
  return false
}

function isPublicStatic(member: ClassElement): boolean {
  const modifiers = flagsOf(member)
  if (modifiers & (ModifierFlags.Private | ModifierFlags.Protected)) return false
  if (!(modifiers & ModifierFlags.Static)) return false
  if (isMethodDeclaration(member) || isPropertyDeclaration(member)) {
    if (isComputedPropertyName(member.name) || isPrivateIdentifier(member.name)) return false
    return !member.name.getText().startsWith('_')
  }
  return false
}

function memberDoc(ctx: RenderContext, where: string, name: string, group: Member[], rel: string): MemberDoc {
  const { sf, text } = load(ctx, rel)
  const first = group[0]
  if (first === undefined) throw new Error(`cordis-core-api: empty member group for ${name}.`)
  const rawDocs = group.map(member => sourceJsDoc(text, sf, member))
  const docIndex = rawDocs.findIndex(raw => parseJsDoc(raw).doc !== '')
  const raw = docIndex === -1 ? '' : (rawDocs[docIndex] ?? '')
  const doc = parseJsDoc(raw).doc
  if (doc === '') ctx.violations.push(`${where} has no JSDoc prose.`)
  const { params: tags, returns } = parseTags(raw)
  const functionMembers = group.filter((member): member is MethodDeclaration | MethodSignatureDeclaration =>
    isMethodDeclaration(member) || isMethodSignatureDeclaration(member))
  const docCarrier = functionMembers[docIndex === -1 ? 0 : docIndex]
  const params: { name: string; text: string }[] = []
  if (docCarrier !== undefined) {
    checkParams(where, 'cordis-core-api', docCarrier.parameters, tags, sf,
      parameter => isIdentifier(parameter.name) && parameter.name.text === 'this', ctx.violations)
    if (docCarrier.type !== undefined) {
      checkReturns(where, docCarrier.type, returns, sf, ctx.violations)
    } else if (returns === null && isMethodDeclaration(docCarrier)) {
      ctx.violations.push(`${where} has no return type annotation; document the result with @returns.`)
    }
    for (const parameter of docCarrier.parameters) {
      if (!isIdentifier(parameter.name) || parameter.name.text === 'this') continue
      const text = tags.get(parameter.name.text)
      if (text !== undefined) params.push({ name: parameter.name.text, text })
    }
  }
  const headingSource = docCarrier ?? functionMembers[0]
  const signatures = isMethodDeclaration(first) && functionMembers.length > 1
    ? functionMembers.filter(member => isMethodDeclaration(member) && member.body === undefined)
    : group
  return {
    name,
    heading: headingSource === undefined ? '' : headingParams(headingSource.parameters, sf),
    signatures: signatures.map(member => signatureOf(member, sf)),
    jsDoc: raw,
    doc,
    params,
    returns,
    source: pointer(rel, sf, first),
  }
}

function heritageMembers(
  statement: InterfaceDeclaration,
  sf: SourceFile,
  groups: Map<string, (MethodSignatureDeclaration | PropertySignatureDeclaration | MethodDeclaration)[]>,
) {
  for (const clause of statement.heritageClauses ?? []) {
    for (const type of clause.types) {
      if (!isIdentifier(type.expression) || type.expression.text !== 'Pick') continue
      const [target, keys] = type.typeArguments ?? []
      if (target === undefined || keys === undefined || !isTypeReferenceNode(target)) continue
      const targetName = target.typeName.getText(sf)
      const cls = sf.statements.find((entry): entry is ClassDeclaration =>
        isClassDeclaration(entry) && entry.name?.text === targetName)
      if (cls === undefined) continue
      const picked = new Set<string>()
      const collect = (node: TypeNode) => {
        if (isLiteralTypeNode(node) && isStringLiteral(node.literal)) picked.add(node.literal.text)
        if (isUnionTypeNode(node)) node.types.forEach(collect)
      }
      collect(keys)
      for (const member of cls.members) {
        if (!isMethodDeclaration(member)) continue
        const name = member.name.getText(sf)
        if (!picked.has(name)) continue
        const group = groups.get(name) ?? []
        group.push(member)
        groups.set(name, group)
      }
    }
  }
}

function contextMergeMembers(ctx: RenderContext, rel: string): MemberDoc[] {
  const { sf } = load(ctx, rel)
  const body = cordisModuleBody(sf)
  if (body === null) throw new Error(`cordis-core-api: ${rel} has no Context module merge.`)
  const groups = new Map<string, (MethodSignatureDeclaration | PropertySignatureDeclaration | MethodDeclaration)[]>()
  for (const statement of body.statements) {
    if (!isInterfaceDeclaration(statement) || statement.name.text !== 'Context') continue
    heritageMembers(statement, sf, groups)
    for (const member of statement.members) {
      if (!isMethodSignatureDeclaration(member) && !isPropertySignatureDeclaration(member)) continue
      if (isComputedPropertyName(member.name)) continue
      const name = member.name.getText(sf)
      const group = groups.get(name) ?? []
      group.push(member)
      groups.set(name, group)
    }
  }
  return [...groups.entries()].map(([name, group]) =>
    memberDoc(ctx, `ctx.${name} (${rel})`, name, group, rel))
}

function classMembers(ctx: RenderContext, rel: string, className: string): {
  doc: string
  instance: MemberDoc[]
  statics: MemberDoc[]
  source: string
} {
  const { sf, text } = load(ctx, rel)
  const cls = sf.statements.find((statement): statement is ClassDeclaration =>
    isClassDeclaration(statement) && statement.name?.text === className)
  if (cls === undefined) throw new Error(`cordis-core-api: class ${className} not found in ${rel}.`)
  const doc = parseJsDoc(rawJsDoc(text, cls)).doc
  if (doc === '') ctx.violations.push(`class ${className} (${pointer(rel, sf, cls)}) has no JSDoc.`)
  const instance = new Map<string, Member[]>()
  const statics = new Map<string, Member[]>()
  for (const member of cls.members) {
    if (!isMethodDeclaration(member) && !isPropertyDeclaration(member) && !isGetAccessorDeclaration(member)) continue
    const name = member.name.getText(sf)
    if (isPublicInstance(member)) {
      const group = instance.get(name) ?? []
      group.push(member)
      instance.set(name, group)
    } else if (isPublicStatic(member) && !isGetAccessorDeclaration(member)) {
      const group = statics.get(name) ?? []
      group.push(member)
      statics.set(name, group)
    }
  }
  const declaration = sf.statements.find((statement): statement is InterfaceDeclaration =>
    isInterfaceDeclaration(statement) && statement.name.text === className)
  for (const member of declaration?.members ?? []) {
    if (!isPropertySignatureDeclaration(member) || isComputedPropertyName(member.name)) continue
    const name = member.name.getText(sf)
    const group = instance.get(name) ?? []
    group.push(member)
    instance.set(name, group)
  }
  const render = (groups: Map<string, Member[]>, prefix: string): MemberDoc[] =>
    [...groups.entries()].map(([name, group]) => memberDoc(ctx, `${prefix}${name} (${rel})`, name, group, rel))
  return {
    doc,
    instance: render(instance, `${className}#`),
    statics: render(statics, `${className}.`),
    source: pointer(rel, sf, cls),
  }
}

function stripBodies(node: Node, sf: SourceFile): string {
  const cuts: { start: number; end: number }[] = []
  const visit = (entry: Node) => {
    const functionLike = isMethodDeclaration(entry)
      || isConstructorDeclaration(entry)
      || isFunctionDeclaration(entry)
      || isGetAccessorDeclaration(entry)
      || isSetAccessorDeclaration(entry)
    if (functionLike && entry.body !== undefined) {
      const signatureEnd = (entry.type ?? entry.parameters.at(-1) ?? entry).getEnd()
      cuts.push({ start: signatureEnd, end: entry.body.getEnd() })
      return
    }
    entry.forEachChild(visit)
  }
  visit(node)
  const base = node.getStart(sf)
  let output = node.getText(sf)
  for (const cut of cuts.sort((left, right) => right.start - left.start)) {
    const head = output.slice(0, cut.start - base)
    const between = output.slice(cut.start - base, cut.end - base)
    const bodyBrace = between.indexOf('{')
    output = head + between.slice(0, bodyBrace).trimEnd() + output.slice(cut.end - base)
  }
  return output
}

function declarationPaste(ctx: RenderContext, rel: string, symbol: string): { doc: string; code: string; source: string } {
  const { sf, text } = load(ctx, rel)
  const matches = sf.statements.filter((statement) => {
    const named = isInterfaceDeclaration(statement)
      || isTypeAliasDeclaration(statement)
      || isClassDeclaration(statement)
      || isEnumDeclaration(statement)
      || isModuleDeclaration(statement)
    return named && statement.name?.getText(sf) === symbol
  })
  const first = matches[0]
  if (first === undefined) throw new Error(`cordis-core-api: declaration ${symbol} not found in ${rel}.`)
  const doc = parseJsDoc(sourceJsDoc(text, sf, first)).doc
  const code = matches.map((statement) => {
    const jsDoc = sourceJsDoc(text, sf, statement)
    const declaration = stripBodies(statement, sf).replace(/^export\s+(default\s+)?/, '')
    return jsDoc === '' ? declaration : `${jsDoc}\n${declaration}`
  }).join('\n\n')
  return { doc, code, source: pointer(rel, sf, first) }
}

function sourceLink(source: string): string {
  const [file, line] = source.split(':')
  return `[Source](../../${file}${line === undefined ? '' : `#L${line}`})`
}

function unlink(text: string): string {
  return text.replace(/\{@link\s+([^}|\s]+)\s*(?:[|\s]\s*([^}]*))?\}/g, (_match, target: string, label?: string) => {
    const name = label?.trim()
    return name && name !== '' ? name : `\`${target}\``
  })
}

function prose(doc: string): string[] {
  const paragraphs = unlink(doc)
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(paragraph => paragraph !== '')
  return paragraphs.flatMap((paragraph, index) => index === 0 ? [paragraph] : ['', paragraph])
}

function renderMember(prefix: string, member: MemberDoc): string[] {
  const lines = [`### ${prefix}${member.name}${member.heading}`, '', `\`\`\`${FENCE}`]
  if (member.jsDoc !== '') lines.push(member.jsDoc)
  lines.push(...member.signatures, '```', '')
  if (member.doc !== '') lines.push(...prose(member.doc), '')
  for (const parameter of member.params) lines.push(`- \`${parameter.name}\` — ${unlink(parameter.text)}`)
  if (member.params.length > 0) lines.push('')
  if (member.returns !== null && member.returns !== '') lines.push(`**Returns** ${unlink(member.returns)}`, '')
  lines.push(sourceLink(member.source), '')
  return lines
}

/** Render one detailed Cordis core API page and reject undocumented members. */
export function renderCordisCoreApiPage(page: CordisCoreApiPage, scanRoot: string = root): string {
  const ctx: RenderContext = { scanRoot, cache: new Map(), violations: [] }
  const lines = [
    '<!-- Generated by scripts/gen-cordis-catalog.ts — do not edit by hand.',
    '     Run `bun run gen-cordis-catalog` to regenerate. -->',
    '',
    `# ${page.title}`,
    '',
    page.intro,
    '',
  ]
  for (const section of page.sections) {
    if (section.kind !== 'decl' && section.heading !== undefined) lines.push(`## ${section.heading}`, '')
    if (section.kind === 'context-merge') {
      for (const member of contextMergeMembers(ctx, section.file)) lines.push(...renderMember('ctx.', member))
    } else if (section.kind === 'class') {
      const cls = classMembers(ctx, section.file, section.symbol)
      if (cls.doc !== '') lines.push(...prose(cls.doc), '')
      lines.push(sourceLink(cls.source), '')
      const prefix = section.prefix ?? `${section.symbol.toLowerCase()}.`
      for (const member of cls.instance) lines.push(...renderMember(prefix, member))
      if (cls.statics.length > 0) {
        lines.push('## Static members', '')
        for (const member of cls.statics) lines.push(...renderMember(`${section.symbol}.`, member))
      }
    } else {
      const declaration = declarationPaste(ctx, section.file, section.symbol)
      lines.push(`## ${section.symbol}`, '')
      if (declaration.doc !== '') lines.push(...prose(declaration.doc), '')
      lines.push(`\`\`\`${FENCE}`, declaration.code, '```', '', sourceLink(declaration.source), '')
    }
  }
  reportViolations('gen-cordis-catalog', ctx.violations)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** Render every detailed Cordis core API page. */
export function renderCordisCoreApiPages(scanRoot: string = root): Map<string, string> {
  return new Map(CORDIS_CORE_API_PAGES.map(page => [page.out, renderCordisCoreApiPage(page, scanRoot)]))
}
