/**
 * Member extraction for {@link ./cordis-core-api.ts}.
 */

import type {
  ClassDeclaration, ClassElement, GetAccessorDeclaration, InterfaceDeclaration, MethodDeclaration,
  MethodSignatureDeclaration, Node, ParameterDeclaration, PropertyDeclaration, PropertySignatureDeclaration,
  SourceFile, TypeNode,
} from 'typescript/unstable/ast'
import { ModifierFlags } from 'typescript/unstable/ast'
import {
  isClassDeclaration, isComputedPropertyName, isGetAccessorDeclaration, isIdentifier, isInterfaceDeclaration,
  isLiteralTypeNode, isMethodDeclaration, isMethodSignatureDeclaration, isPrivateIdentifier,
  isPropertyDeclaration, isPropertySignatureDeclaration, isStringLiteral, isTypeReferenceNode, isUnionTypeNode,
} from 'typescript/unstable/ast/is'
import { checkParams, checkReturns, parseJsDoc, parseTags, pointer, rawJsDoc } from './jsdoc.ts'
import { cordisModuleBody } from './cordis-walk.ts'

export interface MemberDoc {
  name: string
  heading: string
  signatures: string[]
  jsDoc: string
  doc: string
  params: { name: string; text: string }[]
  returns: string | null
  source: string
}

export interface RenderContext {
  scanRoot: string
  cache: Map<string, { sf: SourceFile; text: string }>
  violations: string[]
}

type Member = MethodDeclaration | MethodSignatureDeclaration | PropertyDeclaration
  | PropertySignatureDeclaration | GetAccessorDeclaration

export function sourceJsDoc(text: string, sf: SourceFile, node: Node): string {
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
  const cached = ctx.cache.get(rel)
  if (cached === undefined) throw new Error(`cordis-core-api: ${rel} is not loaded`)
  const { sf, text } = cached
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
      const tagged = tags.get(parameter.name.text)
      if (tagged !== undefined) params.push({ name: parameter.name.text, text: tagged })
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

/** Context-merge members declared in one cordis module block. */
export function contextMergeMembers(ctx: RenderContext, rel: string): MemberDoc[] {
  const cached = ctx.cache.get(rel)
  if (cached === undefined) throw new Error(`cordis-core-api: ${rel} is not loaded`)
  const { sf } = cached
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

/** Instance and static members of one named class, plus same-name interface fields. */
export function classMembers(ctx: RenderContext, rel: string, className: string): {
  doc: string
  instance: MemberDoc[]
  statics: MemberDoc[]
  source: string
} {
  const cached = ctx.cache.get(rel)
  if (cached === undefined) throw new Error(`cordis-core-api: ${rel} is not loaded`)
  const { sf, text } = cached
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
