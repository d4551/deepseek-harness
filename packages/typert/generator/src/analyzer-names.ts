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

export function expressionName(node: Expression): string | undefined {
  if (isIdentifier(node)) return node.text
  if (isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

export function stringLiteralValue(node: Node | undefined): string | undefined {
  return node !== undefined && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

export function isRemoteSegment(value: string): boolean {
  return value !== '.' && value !== '..' && /^[A-Za-z0-9_$.-]+$/.test(value)
}

export interface ModuleIdentity {
  readonly package: string
  readonly subpath: string
}

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
