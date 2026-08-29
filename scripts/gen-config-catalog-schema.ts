/**
 * Schemastery schema walk and plugin entry classification for the config catalog.
 */

import type {
  ClassDeclaration,
  Expression,
  FunctionDeclaration,
} from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isArrayLiteralExpression,
  isAsExpression,
  isCallExpression,
  isClassDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isShorthandPropertyAssignment,
  isSatisfiesExpression,
  isStringLiteral,
  isVariableStatement,
} from 'typescript/unstable/ast/is'
import type { FileCtx } from './gen-config-catalog-model.ts'

function unwrapExpr(expr: Expression): Expression {
  let e = expr
  while (isAsExpression(e) || isSatisfiesExpression(e) || isParenthesizedExpression(e)) e = e.expression
  return e
}

/**
 * Statically walk a schemastery schema expression to its key paths plus the
 * packages whose schemas an intersect composes.
 */
export function walkSchemaExpr(
  ctx: FileCtx,
  expr: Expression,
  where: string,
  violations: string[],
): { keys: string[]; composes: string[] } {
  const keys: string[] = []
  const composes: string[] = []
  const collectValuePaths = (value: Expression, base: string) => {
    const call = unwrapExpr(value)
    if (!isCallExpression(call) || !isPropertyAccessExpression(call.expression)) return
    const method = call.expression.name.text
    if (method === 'object' && call.arguments[0] && isObjectLiteralExpression(call.arguments[0])) {
      for (const prop of call.arguments[0].properties) {
        if (!isPropertyAssignment(prop)) continue
        const key = isStringLiteral(prop.name) ? prop.name.text : prop.name.getText(ctx.sf)
        keys.push(`${base}.${key}`)
        collectValuePaths(prop.initializer, `${base}.${key}`)
      }
      return
    }
    if (method === 'array' && call.arguments[0]) {
      collectValuePaths(call.arguments[0], `${base}[]`)
      return
    }
    const inner = unwrapExpr(call.expression.expression)
    if (isCallExpression(inner)) collectValuePaths(inner, base)
  }
  const visit = (e: Expression) => {
    const call = unwrapExpr(e)
    if (!isCallExpression(call) || !isPropertyAccessExpression(call.expression)) {
      violations.push(`${where}: schema expression is not a statically walkable schemastery call.`)
      return
    }
    const method = call.expression.name.text
    if (method === 'object' && call.arguments[0] && isObjectLiteralExpression(call.arguments[0])) {
      for (const prop of call.arguments[0].properties) {
        if (isPropertyAssignment(prop) || isShorthandPropertyAssignment(prop)) {
          const key = isStringLiteral(prop.name) ? prop.name.text : prop.name.getText(ctx.sf)
          keys.push(key)
          if (isPropertyAssignment(prop)) collectValuePaths(prop.initializer, key)
        } else {
          violations.push(`${where}: schema object property '${prop.getText(ctx.sf)}' is not a plain key.`)
        }
      }
      return
    }
    if (method === 'intersect' && call.arguments[0] && isArrayLiteralExpression(call.arguments[0])) {
      for (const el of call.arguments[0].elements) {
        const part = unwrapExpr(el)
        if (isPropertyAccessExpression(part) && part.name.text === 'Config' && isIdentifier(part.expression)) {
          const imp = ctx.imports.get(part.expression.text)
          if (imp && !imp.specifier.startsWith('.')) { composes.push(imp.specifier); continue }
        }
        if (isCallExpression(part)) { visit(part); continue }
        violations.push(`${where}: intersect element '${part.getText(ctx.sf)}' is neither a workspace plugin's Config nor an inline schema call.`)
      }
      return
    }
    if (method === 'union' && call.arguments[0] && isArrayLiteralExpression(call.arguments[0])) {
      for (const el of call.arguments[0].elements) {
        const part = unwrapExpr(el)
        if (isCallExpression(part)) { visit(part); continue }
      }
      return
    }
    const base = unwrapExpr(call.expression.expression)
    if (isCallExpression(base)) { visit(base); return }
    violations.push(`${where}: schema call '${method}' is not object/intersect and hangs off no walkable base call.`)
  }
  visit(expr)
  return { keys, composes }
}

function hasModifierKind(node: { modifiers?: readonly { kind: SyntaxKind }[] }, kind: SyntaxKind): boolean {
  return node.modifiers?.some(m => m.kind === kind) ?? false
}

/** Find a plugin's schemastery schema expression. */
export function findSchemaExpr(ctx: FileCtx, pluginClass: ClassDeclaration | null): Expression | null {
  for (const stmt of ctx.sf.statements) {
    if (!isVariableStatement(stmt)) continue
    if (!hasModifierKind(stmt, SyntaxKind.ExportKeyword)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (isIdentifier(decl.name) && decl.name.text === 'Config' && decl.initializer) return decl.initializer
    }
  }
  for (const member of pluginClass?.members ?? []) {
    if (!isPropertyDeclaration(member) || member.name.getText() !== 'Config') continue
    if (!hasModifierKind(member, SyntaxKind.StaticKeyword)) continue
    if (member.initializer) return member.initializer
  }
  return null
}

/** Read an `inject` service-key list. */
export function findInject(ctx: FileCtx, pluginClass: ClassDeclaration | null, violations: string[]): string[] {
  const fromArray = (expr: Expression, where: string): string[] => {
    if (!isArrayLiteralExpression(expr)) {
      violations.push(`${where}: inject is not a plain string-array literal; teach the generator the new declaration form.`)
      return []
    }
    return expr.elements.map(el => isStringLiteral(el) ? el.text : el.getText(ctx.sf))
  }
  for (const stmt of ctx.sf.statements) {
    if (!isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (isIdentifier(decl.name) && decl.name.text === 'inject' && decl.initializer) {
        return fromArray(decl.initializer, ctx.rel)
      }
    }
  }
  for (const member of pluginClass?.members ?? []) {
    if (isPropertyDeclaration(member) && member.name.getText() === 'inject' && member.initializer) {
      return fromArray(member.initializer, ctx.rel)
    }
  }
  return []
}

/** Resolve the entry file's default export to its class/function declaration. */
export function defaultExport(ctx: FileCtx): ClassDeclaration | FunctionDeclaration | null {
  for (const stmt of ctx.sf.statements) {
    if (isExportAssignment(stmt) && !stmt.isExportEquals && isIdentifier(stmt.expression)) {
      const name = stmt.expression.text
      for (const s of ctx.sf.statements) {
        if ((isClassDeclaration(s) || isFunctionDeclaration(s)) && s.name?.text === name) return s
      }
      return null
    }
    if ((isClassDeclaration(stmt) || isFunctionDeclaration(stmt))
      && hasModifierKind(stmt, SyntaxKind.DefaultKeyword)) return stmt
  }
  return null
}

/** Find the exported `apply` function declaration in the entry file. */
export function applyExport(ctx: FileCtx): FunctionDeclaration | null {
  for (const stmt of ctx.sf.statements) {
    if (isFunctionDeclaration(stmt) && stmt.name?.text === 'apply'
      && hasModifierKind(stmt, SyntaxKind.ExportKeyword)) return stmt
  }
  return null
}
