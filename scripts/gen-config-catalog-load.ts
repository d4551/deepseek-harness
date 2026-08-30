/**
 * Isolated TypeScript 7 parse and import indexing for the config catalog.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Node } from 'typescript/unstable/ast'
import {
  isEnumDeclaration,
  isExpressionWithTypeArguments,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isNamedImports,
  isNamespaceImport,
  isPropertySignatureDeclaration,
  isQualifiedName,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
  isTypeReferenceNode,
} from 'typescript/unstable/ast/is'
import { parseJsDoc, pointer, rawJsDoc } from './jsdoc.ts'
import { parsePath } from './ts7-session.ts'
import type { FileCtx, TypeDecl, TypeRef } from './gen-config-catalog-model.ts'

/** Parse a source file and index its import declarations. */
export function loadFile(abs: string, rel: string, cache: Map<string, FileCtx>): FileCtx {
  const cached = cache.get(abs)
  if (cached) return cached
  if (!existsSync(abs)) throw new Error(`missing ${rel}`)
  const text = readFileSync(abs, 'utf8')
  const sf = parsePath(abs)
  const imports = new Map<string, { imported: string; specifier: string }>()
  for (const stmt of sf.statements) {
    if (!isImportDeclaration(stmt) || !isStringLiteral(stmt.moduleSpecifier)) continue
    const specifier = stmt.moduleSpecifier.text
    const clause = stmt.importClause
    if (!clause) continue
    if (clause.name) imports.set(clause.name.text, { imported: 'default', specifier })
    if (clause.namedBindings && isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        imports.set(el.name.text, { imported: (el.propertyName ?? el.name).text, specifier })
      }
    }
    if (clause.namedBindings && isNamespaceImport(clause.namedBindings)) {
      imports.set(clause.namedBindings.name.text, { imported: '*', specifier })
    }
  }
  const ctx = { abs, rel, text, sf, imports }
  cache.set(abs, ctx)
  return ctx
}

/** Find a pasteable type declaration by name in a file, or null. */
export function findTypeDecl(ctx: FileCtx, name: string): TypeDecl | null {
  for (const stmt of ctx.sf.statements) {
    if ((isInterfaceDeclaration(stmt) || isTypeAliasDeclaration(stmt) || isEnumDeclaration(stmt))
      && stmt.name.text === name) return stmt
  }
  return null
}

/**
 * Resolve a type name from a file to its declaration (following package-local
 * relative imports transitively) or to the import that brings it in. Returns
 * `null` when the name is neither declared, imported, nor a known global.
 */
export function resolveTypeName(
  ctx: FileCtx,
  name: string,
  cache: Map<string, FileCtx>,
  violations: string[],
): { decl: TypeDecl; ctx: FileCtx } | { ref: TypeRef } | null {
  const local = findTypeDecl(ctx, name)
  if (local) return { decl: local, ctx }
  const imp = ctx.imports.get(name)
  if (!imp) return null
  if (imp.specifier.startsWith('.')) {
    if (!imp.specifier.endsWith('.ts')) {
      violations.push(`${ctx.rel}: relative import '${imp.specifier}' lacks the explicit .ts extension the repo convention requires.`)
      return null
    }
    if (imp.imported !== name) {
      violations.push(`${ctx.rel}: '${name}' aliases '${imp.imported}' across a package-local import; the catalog pastes declarations verbatim, so keep package-local config types unaliased.`)
      return null
    }
    const abs = resolve(dirname(ctx.abs), imp.specifier)
    const rel = ctx.rel.slice(0, ctx.rel.lastIndexOf('/') + 1) + imp.specifier.replace(/^\.\//, '')
    const target = loadFile(abs, rel, cache)
    return resolveTypeName(target, imp.imported, cache, violations)
  }
  return { ref: { alias: name, imported: imp.imported, specifier: imp.specifier } }
}

/** Collect every type NAME referenced in type positions under a node. */
export function collectTypeNames(node: Node, out: Set<string>) {
  const visit = (n: Node) => {
    if (isTypeReferenceNode(n)) {
      let head = n.typeName
      while (isQualifiedName(head)) head = head.left
      if (isIdentifier(head)) out.add(head.text)
    } else if (isExpressionWithTypeArguments(n) && isIdentifier(n.expression)) {
      out.add(n.expression.text)
    }
    n.forEachChild(visit)
  }
  visit(node)
}

/** The verbatim paste text of a declaration: leading JSDoc through the end. */
export function pasteText(ctx: FileCtx, decl: TypeDecl): string {
  const raw = rawJsDoc(ctx.text, decl)
  const start = raw ? ctx.text.indexOf(raw, decl.getFullStart()) : decl.getStart(ctx.sf)
  return ctx.text.slice(start, decl.end)
}

/** Enforce non-empty JSDoc prose on every property of a pasted declaration. */
export function checkMemberDocs(ctx: FileCtx, decl: TypeDecl, violations: string[]) {
  const walkMembers = (members: readonly Node[], path: string) => {
    for (const member of members) {
      if (!isPropertySignatureDeclaration(member)) continue
      const name = member.name.getText(ctx.sf)
      const where = `config field '${path}.${name}' (${pointer(ctx.rel, ctx.sf, member)})`
      if (!parseJsDoc(rawJsDoc(ctx.text, member)).doc) violations.push(`${where} has no JSDoc prose.`)
      if (member.type) walkNested(member.type, `${path}.${name}`)
    }
  }
  const walkNested = (type: Node, path: string) => {
    if (isTypeLiteralNode(type)) {
      walkMembers(type.members, path)
      return
    }
    type.forEachChild((n) => { walkNested(n, path) })
  }
  if (isInterfaceDeclaration(decl)) walkMembers(decl.members, decl.name.text)
  else if (isTypeAliasDeclaration(decl)) walkNested(decl.type, decl.name.text)
}
