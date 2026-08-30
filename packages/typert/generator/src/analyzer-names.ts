/**
 * Name and specifier helpers for Typert extraction.
 */

import type { Expression, Node } from 'typescript/unstable/ast'
import {
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
} from 'typescript/unstable/ast/is'

/**
 * The name an expression denotes.
 * @param node - identifier or property access.
 * @returns the identifier text, the accessed member name, or undefined for any
 *   other expression.
 */
export function expressionName(node: Expression): string | undefined {
  if (isIdentifier(node)) return node.text
  if (isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

/**
 * The text of a string literal node.
 * @param node - candidate node, or undefined.
 * @returns the literal text for a quoted or untagged template literal,
 *   undefined otherwise.
 */
export function stringLiteralValue(node: Node | undefined): string | undefined {
  return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

/**
 * Whether a string is usable as one RPC endpoint segment.
 * @param value - candidate segment.
 * @returns true for a non-relative segment of letters, digits, `_`, `$`, `.`, or `-`.
 */
export function isRemoteSegment(value: string): boolean {
  return value !== '.' && value !== '..' && /^[A-Za-z0-9_$.-]+$/.test(value)
}

/** A bare module specifier split into the package that owns it and its export subpath. */
export interface ModuleIdentity {
  /** Package name, scope included. */
  readonly package: string
  /** Export subpath, `.` for the root entry. */
  readonly subpath: string
}

/**
 * Split a bare module specifier into package and export subpath.
 * @param specifier - import specifier.
 * @returns the identity, or undefined for a relative or absolute specifier.
 */
export function moduleIdentity(specifier: string): ModuleIdentity | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined
  const parts = specifier.split('/')
  const packageLength = specifier.startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  const rest = parts.slice(packageLength).join('/')
  return {
    package: packageName,
    subpath: rest.length === 0 ? '.' : `./${rest}`,
  }
}

/**
 * The installed package a file belongs to, read from its last `node_modules` segment.
 * @param file - source-file path.
 * @returns the package with the root subpath, or undefined for a file outside
 *   any `node_modules`.
 */
export function externalModuleIdentityForFile(file: string): ModuleIdentity | undefined {
  const normalized = file.replaceAll('\\', '/')
  const marker = '/node_modules/'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return undefined
  const parts = normalized.slice(index + marker.length).split('/')
  const first = parts[0]
  if (first === undefined) return undefined
  const packageLength = first.startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  return { package: packageName, subpath: '.' }
}
