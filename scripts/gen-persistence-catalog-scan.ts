/**
 * SessionEventMap and envelope-type collection for {@link ./gen-persistence-catalog.ts}.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { InterfaceDeclaration, Node, SourceFile, TypeNode } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isModuleBlock,
  isModuleDeclaration,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isUnionTypeNode,
} from 'typescript/unstable/ast/is'
import { parseJsDoc, pointer, rawJsDoc, reportViolations } from './jsdoc.ts'
import { parsePath, printInFile, readConfigFile } from './ts7-session.ts'

const root = resolve(import.meta.dirname, '..')
const SESSION_PACKAGE = '@deepseek-ai/dsh-session'
const SESSION_TYPES_MODULE = '@deepseek-ai/dsh-session/types'
const EVENT_ENVELOPE_TYPE_NAMES = [
  'SessionEventType',
  'SurfaceEventType',
  'SurfaceOp',
  'SessionEvent',
] as const

type EventEnvelopeTypeName = typeof EVENT_ENVELOPE_TYPE_NAMES[number]

export interface LogEventEntry {
  name: string
  scope: string
  payload: string
  declaration: string
  doc: string
  source: string
}

export interface AnnotatedLogEventEntry extends LogEventEntry {
  surface: boolean
}

export interface EventEnvelopeTypeEntry {
  name: EventEnvelopeTypeName
  declaration: string
  source: string
}

function payloadText(type: TypeNode, sf: SourceFile): string {
  // Printed, not read from source: the catalog fragment is one normalized line,
  // and only the emitter separates members with `;` and drops their JSDoc.
  return printInFile(sf.fileName, type).replace(/\s+/g, ' ').replace(/;\s*\}/g, ' }').trim()
}

function declarationText(text: string, sf: SourceFile, node: Node): string {
  const raw = rawJsDoc(text, node)
  const nodeStart = node.getStart(sf)
  const start = raw ? text.lastIndexOf(raw, nodeStart) : nodeStart
  const { line } = sf.getLineAndCharacterOfPosition(start)
  const lineStart = sf.getPositionOfLineAndCharacter(line, 0)
  const indent = text.slice(lineStart, start)
  return text.slice(lineStart, node.end)
    .split('\n')
    .map(lineText => lineText.startsWith(indent) ? lineText.slice(indent.length) : lineText)
    .join('\n')
    .trimEnd()
}

function sessionEventMapDecls(sf: SourceFile): { decl: InterfaceDeclaration; topLevel: boolean }[] {
  const decls: { decl: InterfaceDeclaration; topLevel: boolean }[] = []
  for (const stmt of sf.statements) {
    if (isInterfaceDeclaration(stmt) && stmt.name.text === 'SessionEventMap') decls.push({ decl: stmt, topLevel: true })
    if (isModuleDeclaration(stmt) && isStringLiteral(stmt.name) && stmt.name.text === SESSION_TYPES_MODULE
      && stmt.body !== undefined && isModuleBlock(stmt.body)) {
      for (const inner of stmt.body.statements) {
        if (isInterfaceDeclaration(inner) && inner.name.text === 'SessionEventMap') decls.push({ decl: inner, topLevel: false })
      }
    }
  }
  return decls
}

function packageNameFor(rel: string, scanRoot: string): string | null {
  const dir = rel.split('/').slice(0, 3).join('/')
  const manifestPath = resolve(scanRoot, dir, 'package.json')
  if (!existsSync(manifestPath)) return null
  const parsed = readConfigFile(manifestPath)
  if (parsed.error !== undefined || parsed.config === null || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
    return null
  }
  const name: unknown = Reflect.get(parsed.config, 'name')
  return typeof name === 'string' ? name : null
}

/** Collect every SessionEventMap merge. */
export function collectLogEvents(scanRoot: string = root): LogEventEntry[] {
  const entries: LogEventEntry[] = []
  const violations: string[] = []
  const seen = new Map<string, string>()
  let owningDecl: string | null = null
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('SessionEventMap')) continue
    const sf = parsePath(abs)
    for (const { decl, topLevel } of sessionEventMapDecls(sf)) {
      const declSrc = pointer(rel, sf, decl)
      if (topLevel) {
        const pkg = packageNameFor(rel, scanRoot)
        if (pkg !== SESSION_PACKAGE) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is outside ${SESSION_PACKAGE} (package ${pkg ?? 'unknown'}). Rename the interface, or contribute events via declare module '${SESSION_TYPES_MODULE}'.`)
          continue
        }
        const exported = decl.modifiers?.some(m => m.kind === SyntaxKind.ExportKeyword) ?? false
        if (!exported) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is not exported; the owning vocabulary is the single exported declaration — rename a local helper interface.`)
          continue
        }
        if (owningDecl) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is already declared at ${owningDecl}; the owning vocabulary has exactly one home.`)
          continue
        }
        owningDecl = declSrc
      }
      if (decl.heritageClauses?.length) {
        violations.push(`SessionEventMap declaration (${declSrc}) uses extends; inherited keys would join keyof SessionEventMap without a catalog row — declare event members directly.`)
      }
      for (const member of decl.members) {
        const src = pointer(rel, sf, member)
        // TS7 declares PropertySignatureDeclaration.type non-optional; an unannotated member parses with none.
        // oxlint-disable-next-line typescript/no-unnecessary-condition
        if (!isPropertySignatureDeclaration(member) || member.type === undefined) {
          const label = isPropertySignatureDeclaration(member) ? member.name.getText(sf) : member.getText(sf).replace(/\s+/g, ' ')
          violations.push(`SessionEventMap member ${label} (${src}) is not a property signature with an explicit payload type; declare every log event as 'scope/name': <payload>.`)
          continue
        }
        if (!isStringLiteral(member.name)) {
          violations.push(`log event at ${src} has a non-literal name; the catalog needs string-literal event names.`)
          continue
        }
        const name = member.name.text
        const where = `log event '${name}' (${src})`
        const prior = seen.get(name)
        if (prior) {
          violations.push(`${where} is already declared at ${prior}; an event type has exactly one declaration.`)
          continue
        }
        seen.set(name, src)
        const payload = payloadText(member.type, sf)
        const { doc, hasMode } = parseJsDoc(rawJsDoc(text, member))
        if (hasMode) {
          violations.push(`${where} carries an @mode tag, but a log event has no dispatch mode (it is not a cordis bus event — it rides the 'session/event' emit). Remove the tag.`)
        }
        if (!doc) {
          violations.push(`${where} has no description prose. Say what the event records and what its payload means — the JSDoc becomes the catalog entry.`)
        }
        entries.push({
          name,
          scope: name.split('/')[0] ?? name,
          payload,
          declaration: declarationText(text, sf, member),
          doc,
          source: src,
        })
      }
    }
  }
  reportViolations('gen-persistence-catalog', violations)
  return entries
}

/** Collect exported persisted envelope type declarations. */
export function collectEventEnvelopeTypes(scanRoot: string = root): EventEnvelopeTypeEntry[] {
  const found = new Map<EventEnvelopeTypeName, EventEnvelopeTypeEntry>()
  const violations: string[] = []
  const wanted = new Set<string>(EVENT_ENVELOPE_TYPE_NAMES)
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!EVENT_ENVELOPE_TYPE_NAMES.some(name => text.includes(name))) continue
    if (packageNameFor(rel, scanRoot) !== SESSION_PACKAGE) continue
    const sf = parsePath(abs)
    for (const stmt of sf.statements) {
      if (!isTypeAliasDeclaration(stmt) || !wanted.has(stmt.name.text)) continue
      const name = stmt.name.text
      if (name !== 'SessionEventType' && name !== 'SurfaceEventType' && name !== 'SurfaceOp' && name !== 'SessionEvent') continue
      const src = pointer(rel, sf, stmt)
      const where = `event-envelope type '${name}' (${src})`
      const prior = found.get(name)
      if (prior) {
        violations.push(`${where} is already declared at ${prior.source}; the persisted envelope type has exactly one owner.`)
        continue
      }
      if (!(stmt.modifiers?.some(m => m.kind === SyntaxKind.ExportKeyword) ?? false)) {
        violations.push(`${where} is not exported.`)
      }
      const { doc, hasMode } = parseJsDoc(rawJsDoc(text, stmt))
      if (hasMode) violations.push(`${where} carries an @mode tag, but a persisted type has no dispatch mode.`)
      if (!doc) violations.push(`${where} has no description prose. The full JSDoc is part of the generated catalog.`)
      found.set(name, { name, declaration: declarationText(text, sf, stmt), source: src })
    }
  }
  const missing = EVENT_ENVELOPE_TYPE_NAMES.filter(name => !found.has(name))
  if (missing.length > 0) {
    violations.push(`missing event-envelope declaration(s): ${missing.join(', ')}.`)
  }
  reportViolations('gen-persistence-catalog', violations)
  return EVENT_ENVELOPE_TYPE_NAMES.map((name) => {
    const entry = found.get(name)
    if (entry === undefined) throw new Error(`gen-persistence-catalog: missing checked event-envelope declaration '${name}'.`)
    return entry
  })
}

/** Parse the SurfaceEventType union of literal event names. */
export function collectSurfaceEventTypes(scanRoot: string = root): string[] {
  const found: { names: string[]; source: string }[] = []
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('SurfaceEventType')) continue
    const sf = parsePath(abs)
    for (const stmt of sf.statements) {
      if (!isTypeAliasDeclaration(stmt) || stmt.name.text !== 'SurfaceEventType') continue
      const src = pointer(rel, sf, stmt)
      const members = isUnionTypeNode(stmt.type) ? [...stmt.type.types] : [stmt.type]
      const names: string[] = []
      for (const m of members) {
        if (isLiteralTypeNode(m) && isStringLiteral(m.literal)) names.push(m.literal.text)
        else throw new Error(`gen-persistence-catalog: SurfaceEventType (${src}) has a non-string-literal member; the badge derivation needs a closed literal union.`)
      }
      found.push({ names, source: src })
    }
  }
  const only = found[0]
  if (only === undefined) throw new Error('gen-persistence-catalog: no SurfaceEventType union found under packages/*/*/src.')
  if (found.length > 1) throw new Error(`gen-persistence-catalog: SurfaceEventType is declared more than once (${found.map(f => f.source).join(', ')}); the surface subset has exactly one owner.`)
  return only.names
}

/** Attach the surface/log-only badge to each event. */
export function annotateSurface(events: LogEventEntry[], surfaceTypes: string[]): AnnotatedLogEventEntry[] {
  const names = new Set(events.map(e => e.name))
  const stale = surfaceTypes.filter(t => !names.has(t))
  if (stale.length > 0) {
    throw new Error(`gen-persistence-catalog: SurfaceEventType member(s) ${stale.map(t => `'${t}'`).join(', ')} name no declared log event (stale union member?).`)
  }
  const surface = new Set(surfaceTypes)
  return events.map(e => ({ ...e, surface: surface.has(e.name) }))
}
