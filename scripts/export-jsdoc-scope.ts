/**
 * Scope walk for {@link ./verify-export-jsdoc.ts}: dispatch exported
 * statements, `export { … }` lists, and namespace bodies.
 */

import type { Node, Statement } from 'typescript/unstable/ast'
import {
  isArrowFunction,
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamedExports,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
} from 'typescript/unstable/ast/is'
import { SignatureKind, SymbolFlags } from 'typescript/unstable/sync'
import {
  PROTOCOL_EXPORTS,
  callableAnnotation,
  checkClass,
  checkDescribed,
  checkFunctionLike,
  declarationName,
  hasModifierFlag,
  unwrapExpression,
  type Walk,
} from './export-jsdoc-contract.ts'
import { parseJsDoc, pointer, rawJsDoc } from './jsdoc.ts'
import { ModifierFlags } from 'typescript/unstable/ast'

function checkDecl(
  stmt: Statement,
  prefix: string,
  overloadSigs: Set<string>,
  byName: Map<string, Statement[]>,
  ambient: boolean,
  w: Walk,
  only: ReadonlySet<string> | null = null,
): void {
  const at = (n: Node): string => ` (${pointer(w.rel, w.sf, n)})`
  if (isFunctionDeclaration(stmt)) {
    const name = stmt.name?.text ?? 'default'
    if (prefix === '' && PROTOCOL_EXPORTS.has(name)) return
    if (stmt.body && overloadSigs.has(name)) return
    checkFunctionLike(`exported function '${prefix}${name}'${at(stmt)}`, rawJsDoc(w.text, stmt),
      stmt.parameters, stmt.type, false, w)
    return
  }
  if (isClassDeclaration(stmt)) {
    checkClass(stmt, `${prefix}${stmt.name?.text ?? 'default'}`, w)
    return
  }
  if (isInterfaceDeclaration(stmt)) {
    checkDescribed(`exported interface '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(w.text, stmt), w)
    return
  }
  if (isTypeAliasDeclaration(stmt)) {
    checkDescribed(`exported type '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(w.text, stmt), w)
    return
  }
  if (isEnumDeclaration(stmt)) {
    checkDescribed(`exported enum '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(w.text, stmt), w)
    return
  }
  if (isVariableStatement(stmt)) {
    const raw = rawJsDoc(w.text, stmt)
    for (const d of stmt.declarationList.declarations) {
      const name = isIdentifier(d.name) ? d.name.text : d.name.getText(w.sf)
      if (only !== null && !only.has(name)) continue
      if (prefix === '' && PROTOCOL_EXPORTS.has(name)) continue
      const where = `exported const '${prefix}${name}'${at(d)}`
      const annotation = d.type !== undefined ? callableAnnotation(d.type) : null
      const init = d.initializer !== undefined ? unwrapExpression(d.initializer) : undefined
      if (annotation === 'refuse') {
        w.violations.push(`${where}: its callable type literal is not gate-classifiable; extract a named type and document it there.`)
      } else if (annotation !== null) {
        checkFunctionLike(where, raw, annotation.parameters, annotation.type, false, w)
      } else if (init !== undefined && (isArrowFunction(init) || isFunctionExpression(init))) {
        checkFunctionLike(where, raw, init.parameters, init.type, init.type === undefined && d.type !== undefined, w)
      } else {
        checkDescribed(where, raw, w)
      }
    }
    return
  }
  if (isModuleDeclaration(stmt) && isIdentifier(stmt.name)) {
    const siblings = (byName.get(stmt.name.text) ?? []).filter(s => s !== stmt)
    const merged = siblings.some(s => parseJsDoc(rawJsDoc(w.text, s)).doc !== '')
    if (!merged) checkDescribed(`exported namespace '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(w.text, stmt), w)
    let body = stmt.body
    let nsPrefix = `${prefix}${stmt.name.text}.`
    while (body !== undefined && isModuleDeclaration(body)) {
      nsPrefix += `${body.name.getText(w.sf)}.`
      body = body.body
    }
    const declared = ambient || hasModifierFlag(stmt, ModifierFlags.Ambient)
    if (body !== undefined && isModuleBlock(body)) checkScope(body.statements, nsPrefix, w, declared)
    return
  }
  if (isImportEqualsDeclaration(stmt)) {
    const where = `exported alias '${prefix}${stmt.name.text}'${at(stmt)}`
    const sym = w.checker.getSymbolAtLocation(stmt.name)
    const target = sym !== undefined && (sym.flags & SymbolFlags.Alias) !== 0 ? w.checker.getAliasedSymbol(sym) : sym
    const RICH_TARGETS = SymbolFlags.Function | SymbolFlags.Class | SymbolFlags.ValueModule | SymbolFlags.NamespaceModule
    const type = target === undefined ? undefined : w.checker.getTypeOfSymbol(target)
    const calls = type === undefined ? [] : w.checker.getSignaturesOfType(type, SignatureKind.Call)
    const rich = target === undefined
      || (target.flags & RICH_TARGETS) !== 0
      || calls.length > 0
    if (rich) {
      w.violations.push(`${where} aliases a callable, class, or namespace target whose signature/member contract the alias cannot carry; export the declaration directly instead.`)
      return
    }
    checkDescribed(where, rawJsDoc(w.text, stmt), w)
    return
  }
  w.violations.push(`exported statement${at(stmt)} uses an export form verify-export-jsdoc does not handle; extend the gate.`)
}

/**
 * Walk one lexical scope and check every exported declaration.
 * @param statements - the scope's statements.
 * @param prefix - namespace qualification (`''` at top level).
 * @param w - walk state.
 * @param ambient - whether members export implicitly.
 * @param allowedNames - restricted public names, when the package does not export `src/*`.
 */
export function checkScope(
  statements: readonly Statement[],
  prefix: string,
  w: Walk,
  ambient: boolean,
  allowedNames?: ReadonlySet<string>,
): void {
  const byName = new Map<string, Statement[]>()
  const overloadSigs = new Set<string>()
  const add = (name: string, stmt: Statement): void => {
    byName.set(name, [...(byName.get(name) ?? []), stmt])
  }
  for (const stmt of statements) {
    if (isFunctionDeclaration(stmt)) {
      if (stmt.name) add(stmt.name.text, stmt)
      if (!stmt.body && stmt.name) overloadSigs.add(stmt.name.text)
    } else if (isClassDeclaration(stmt) || isInterfaceDeclaration(stmt)
      || isTypeAliasDeclaration(stmt) || isEnumDeclaration(stmt)) {
      if (stmt.name) add(stmt.name.text, stmt)
    } else if (isModuleDeclaration(stmt) && isIdentifier(stmt.name)) {
      add(stmt.name.text, stmt)
    } else if (isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (isIdentifier(d.name)) add(d.name.text, stmt)
      }
    }
  }
  const requested = new Map<Statement, Set<string> | null>()
  const request = (stmt: Statement, name: string | null): void => {
    const prior = requested.get(stmt)
    if (name === null || prior === null) {
      requested.set(stmt, null)
      return
    }
    requested.set(stmt, prior === undefined ? new Set([name]) : prior.add(name))
  }
  for (const stmt of statements) {
    if (isModuleDeclaration(stmt) && (
      isStringLiteral(stmt.name)
      || (isIdentifier(stmt.name) && stmt.name.text === 'global' && hasModifierFlag(stmt, ModifierFlags.Ambient))
    )) {
      continue
    }
    if (isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier) continue
      if (stmt.exportClause && isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text
          for (const decl of byName.get(local) ?? []) request(decl, local)
        }
      }
      continue
    }
    if (isExportAssignment(stmt)) {
      if (stmt.isExportEquals) {
        w.violations.push(`export-equals assignment (${pointer(w.rel, w.sf, stmt)}) is not a gate-supported export form; use ESM named exports.`)
        continue
      }
      const where = `default export (${pointer(w.rel, w.sf, stmt)})`
      const expr = unwrapExpression(stmt.expression)
      if (isIdentifier(expr)) {
        for (const decl of byName.get(expr.text) ?? []) request(decl, expr.text)
      } else if (isArrowFunction(expr) || isFunctionExpression(expr)) {
        checkFunctionLike(where, rawJsDoc(w.text, stmt), expr.parameters, expr.type, false, w)
      } else {
        checkDescribed(where, rawJsDoc(w.text, stmt), w)
      }
      continue
    }
    if (hasModifierFlag(stmt, ModifierFlags.Export) || (ambient && !isImportDeclaration(stmt))) {
      if (allowedNames === undefined) {
        request(stmt, null)
      } else if (isVariableStatement(stmt)) {
        for (const declaration of stmt.declarationList.declarations) {
          if (isIdentifier(declaration.name) && allowedNames.has(declaration.name.text)) {
            request(stmt, declaration.name.text)
          }
        }
      } else {
        const name = declarationName(stmt) ?? 'default'
        if (allowedNames.has(name)) request(stmt, null)
      }
    }
  }
  for (const stmt of statements) {
    const only = requested.get(stmt)
    if (only !== undefined) checkDecl(stmt, prefix, overloadSigs, byName, ambient, w, only)
  }
}
