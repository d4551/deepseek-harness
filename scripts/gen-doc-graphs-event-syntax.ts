/**
 * Expression peeling and type-literal helpers for the event-relation collector.
 */

import type {
  Expression, FunctionDeclaration, Identifier, Node, VariableDeclaration,
} from 'typescript/unstable/ast'
import { NodeFlags, SyntaxKind } from 'typescript/unstable/ast'
import {
  isAsExpression,
  isCallExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isTypeAssertion,
  isVariableDeclarationList,
} from 'typescript/unstable/ast/is'
import type { Type } from 'typescript/unstable/sync'
import { TypeFlags } from 'typescript/unstable/sync'

/** Peel syntax-only wrappers that do not change an expression's runtime value. */
export function unwrapExpression(expression: Expression): Expression {
  let current = expression
  while (
    isParenthesizedExpression(current)
    || isAsExpression(current)
    || isTypeAssertion(current)
    || isNonNullExpression(current)
    || isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** Whether an identifier is the callee of a call, seen through value-preserving wrappers. */
export function isDirectCallee(identifier: Identifier): boolean {
  let current: Node = identifier
  while (
    isParenthesizedExpression(current.parent)
    || isAsExpression(current.parent)
    || isTypeAssertion(current.parent)
    || isNonNullExpression(current.parent)
    || isSatisfiesExpression(current.parent)
  ) {
    current = current.parent
  }
  return isCallExpression(current.parent) && current.parent.expression === current
}

/** Whether a variable declaration belongs to a const declaration list. */
export function isConstDeclaration(declaration: VariableDeclaration): boolean {
  const parent = declaration.parent
  return isVariableDeclarationList(parent) && (parent.flags & NodeFlags.Const) !== 0
}

/** Whether a function declaration is exported or default-exported. */
export function hasExportModifier(node: FunctionDeclaration): boolean {
  return node.modifiers?.some((modifier) => {
    return modifier.kind === SyntaxKind.ExportKeyword || modifier.kind === SyntaxKind.DefaultKeyword
  }) ?? false
}

/** Add every member of source to target. */
export function addAll<T>(target: Set<T>, source: ReadonlySet<T>): void {
  for (const value of source) target.add(value)
}

/** Return the union of two sets without mutating either input. */
export function unionSets<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): Set<T> {
  const out = new Set(left)
  addAll(out, right)
  return out
}

/** Return every value only when a type is a closed string-literal union. */
export function finiteStringTypeValues(type: Type): Set<string> | undefined {
  if (type.isStringLiteralType()) return new Set([type.value])
  if ((type.flags & TypeFlags.Never) !== 0) return new Set()
  if (!type.isUnionType()) return undefined
  const members = type.getTypes()
  const values = new Set<string>()
  for (const member of members) {
    const memberValues = finiteStringTypeValues(member)
    if (memberValues === undefined) return undefined
    addAll(values, memberValues)
  }
  return values
}
