/**
 * Schema key-path presence against declared config types.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Node, TypeElement } from 'typescript/unstable/ast'
import {
  isArrayTypeNode,
  isExportDeclaration,
  isIdentifier,
  isIndexedAccessTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isNamedExports,
  isParenthesizedTypeNode,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isIntersectionTypeNode,
  isUnionTypeNode,
} from 'typescript/unstable/ast/is'
import { findTypeDecl, loadFile } from './gen-config-catalog-load.ts'
import type { FileCtx, PathLookup, PathStep, TypeDecl, World } from './gen-config-catalog-model.ts'

/** Parse a schema key path (`agents[].id`) into member/array steps. */
export function parseSchemaPath(path: string): PathStep[] {
  const steps: PathStep[] = []
  for (const seg of path.split('.')) {
    let name = seg
    let arrays = 0
    while (name.endsWith('[]')) {
      name = name.slice(0, -2)
      arrays += 1
    }
    steps.push({ member: name })
    for (let i = 0; i < arrays; i += 1) steps.push({ array: true })
  }
  return steps
}

/** Load a package-relative import target as a FileCtx. */
function loadRelative(world: World, from: FileCtx, specifier: string): FileCtx {
  const abs = resolve(dirname(from.abs), specifier)
  const rel = from.rel.slice(0, from.rel.lastIndexOf('/') + 1) + specifier.replace(/^\.\//, '')
  return loadFile(abs, rel, world.cache)
}

/** Find a type declaration exported from a file, following relative re-exports. */
export function findExportedTypeDecl(
  world: World,
  ctx: FileCtx,
  name: string,
  seen = new Set<string>(),
): { decl: TypeDecl; ctx: FileCtx } | null {
  const key = `${ctx.abs}#${name}`
  if (seen.has(key)) return null
  seen.add(key)
  const local = findTypeDecl(ctx, name)
  if (local) return { decl: local, ctx }
  for (const stmt of ctx.sf.statements) {
    if (!isExportDeclaration(stmt) || !stmt.moduleSpecifier || !isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith('.') || !spec.endsWith('.ts')) continue
    let lookFor: string | null = null
    if (!stmt.exportClause) {
      lookFor = name
    } else if (isNamedExports(stmt.exportClause)) {
      const el = stmt.exportClause.elements.find(e => e.name.text === name)
      if (el) lookFor = (el.propertyName ?? el.name).text
    }
    if (lookFor === null) continue
    const hit = findExportedTypeDecl(world, loadRelative(world, ctx, spec), lookFor, seen)
    if (hit) return hit
  }
  return null
}

/** Resolve a referenced type NAME to its declaration or `'unknown'`. */
export function declForTypeName(
  world: World,
  ctx: FileCtx,
  name: string,
): { decl: TypeDecl; ctx: FileCtx } | 'unknown' {
  const local = findTypeDecl(ctx, name)
  if (local) return { decl: local, ctx }
  const imp = ctx.imports.get(name)
  if (!imp) return 'unknown'
  if (imp.specifier.startsWith('.')) {
    if (!imp.specifier.endsWith('.ts')) return 'unknown'
    return findExportedTypeDecl(world, loadRelative(world, ctx, imp.specifier), imp.imported) ?? 'unknown'
  }
  const dir = world.pkgDirByName.get(imp.specifier)
  if (dir === undefined) return 'unknown'
  const entryRel = `${dir}/src/index.ts`
  const abs = resolve(world.scanRoot, entryRel)
  if (!existsSync(abs)) return 'unknown'
  const entry = loadFile(abs, entryRel, world.cache)
  return findExportedTypeDecl(world, entry, imp.imported) ?? 'unknown'
}

const PASSTHROUGH_WRAPPERS = new Set(['Partial', 'Required', 'Readonly', 'NonNullable'])

function combine(results: PathLookup[]): PathLookup {
  if (results.includes('found')) return 'found'
  if (results.includes('unknown')) return 'unknown'
  return 'missing'
}

function intoMembers(
  world: World,
  ctx: FileCtx,
  members: readonly TypeElement[],
  step: PathStep,
  steps: PathStep[],
  seen: Set<string>,
): PathLookup | null {
  if (!('member' in step)) return null
  for (const m of members) {
    if (!isPropertySignatureDeclaration(m) || m.name.getText(ctx.sf) !== step.member) continue
    if (steps.length === 1) return 'found'
    return m.type ? lookupPath(world, ctx, m.type, steps.slice(1), seen) : 'unknown'
  }
  return null
}

/**
 * Walk a schema key path against a declared type. Presence check only:
 * `'unknown'` never mis-reports a miss.
 */
export function lookupPath(
  world: World,
  ctx: FileCtx,
  node: Node,
  steps: PathStep[],
  seen: Set<string>,
): PathLookup {
  if (steps.length === 0) return 'found'
  if (isInterfaceDeclaration(node) || isTypeAliasDeclaration(node)) {
    const key = `${ctx.abs}:${String(node.pos)}:${String(steps.length)}`
    if (seen.has(key)) return 'unknown'
    seen.add(key)
  }
  const step = steps[0]
  if (step === undefined) return 'found'
  if (isInterfaceDeclaration(node)) {
    if (!('member' in step)) return 'unknown'
    const direct = intoMembers(world, ctx, node.members, step, steps, seen)
    if (direct !== null) return direct
    const bases: PathLookup[] = []
    for (const clause of node.heritageClauses ?? []) {
      for (const base of clause.types) {
        if (!isIdentifier(base.expression)) {
          bases.push('unknown')
          continue
        }
        const resolved = declForTypeName(world, ctx, base.expression.text)
        bases.push(resolved === 'unknown' ? 'unknown' : lookupPath(world, resolved.ctx, resolved.decl, steps, seen))
      }
    }
    return bases.length ? combine(bases) : 'missing'
  }
  if (isTypeAliasDeclaration(node)) return lookupPath(world, ctx, node.type, steps, seen)
  if (isTypeLiteralNode(node)) {
    if (!('member' in step)) return 'unknown'
    return intoMembers(world, ctx, node.members, step, steps, seen) ?? 'missing'
  }
  if (isParenthesizedTypeNode(node)) return lookupPath(world, ctx, node.type, steps, seen)
  if (isIntersectionTypeNode(node)) {
    return combine(node.types.map(t => lookupPath(world, ctx, t, steps, seen)))
  }
  if (isUnionTypeNode(node)) {
    const results = node.types.map(t => lookupPath(world, ctx, t, steps, seen))
    if (results.every(r => r === 'found')) return 'found'
    if (results.every(r => r === 'missing')) return 'missing'
    return 'unknown'
  }
  if (isArrayTypeNode(node)) {
    return 'array' in step ? lookupPath(world, ctx, node.elementType, steps.slice(1), seen) : 'unknown'
  }
  if (isTypeOperatorNode(node)) return lookupPath(world, ctx, node.type, steps, seen)
  if (isIndexedAccessTypeNode(node)) {
    const index = node.indexType
    if (isLiteralTypeNode(index) && isStringLiteral(index.literal)) {
      return lookupPath(world, ctx, node.objectType, [{ member: index.literal.text }, ...steps], seen)
    }
    return 'unknown'
  }
  if (isTypeReferenceNode(node)) {
    let head = node.typeName
    while (isQualifiedName(head)) head = head.left
    const name = head.text
    if (PASSTHROUGH_WRAPPERS.has(name) && node.typeArguments?.[0]) {
      return lookupPath(world, ctx, node.typeArguments[0], steps, seen)
    }
    if ((name === 'Array' || name === 'ReadonlyArray') && node.typeArguments?.[0]) {
      return 'array' in step ? lookupPath(world, ctx, node.typeArguments[0], steps.slice(1), seen) : 'unknown'
    }
    if (!isIdentifier(node.typeName)) return 'unknown'
    const resolved = declForTypeName(world, ctx, name)
    return resolved === 'unknown' ? 'unknown' : lookupPath(world, resolved.ctx, resolved.decl, steps, seen)
  }
  return 'unknown'
}
