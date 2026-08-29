/**
 * Lexical helpers for {@link ./gen-scoped-events.ts}: Events-module tests and
 * @dshScopeScan tag parsing.
 */
import type { InterfaceDeclaration } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isModuleBlock,
  isModuleDeclaration,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import type { Symbol, Type } from 'typescript/unstable/sync'

export interface SubjectCandidate {
  path: string
  parameter: number
  property?: string
  type: Type
}

export interface ScopeTag {
  present: boolean
  unsupported: boolean
}

/** Return whether an Events interface is inside declare module '@deepseek-ai/cordis'. */
export function isCordisModuleInterface(node: InterfaceDeclaration): boolean {
  const block = node.parent
  const declaration = block.parent
  return isModuleBlock(block)
    && isModuleDeclaration(declaration)
    && isStringLiteral(declaration.name)
    && declaration.name.text === '@deepseek-ai/cordis'
}

/** Parse and validate the optional @dshScopeScan unsupported tag. */
export function parseScopeTag(raw: string, where: string, violations: string[]): ScopeTag {
  const tags = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*\*?\s?/, '').trim())
    .filter(line => line.startsWith('@dshScopeScan'))
  if (tags.length > 1) violations.push(`${where} has multiple @dshScopeScan tags`)
  if (tags.length === 0) return { present: false, unsupported: false }
  const unsupported = tags[0] === '@dshScopeScan unsupported'
  if (!unsupported) {
    violations.push(
      `${where} has invalid scoped-event scan metadata '${tags[0]}'; expected '@dshScopeScan unsupported'`,
    )
  }
  return { present: true, unsupported }
}

/** Return whether a property has a private or protected declaration. */
export function hasNonPublicDeclaration(symbol: Symbol): boolean {
  return symbol.declarations.some((handle) => {
    const declaration = handle.resolve()
    if (declaration === undefined || !('modifiers' in declaration)) return false
    const modifiers = declaration.modifiers as readonly { readonly kind: SyntaxKind }[] | undefined
    return modifiers?.some((modifier) => {
      return modifier.kind === SyntaxKind.PrivateKeyword || modifier.kind === SyntaxKind.ProtectedKeyword
    }) ?? false
  })
}

/** Deduplicate candidate paths contributed by merged/intersection types. */
export function dedupeCandidates(candidates: readonly SubjectCandidate[]): SubjectCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false
    seen.add(candidate.path)
    return true
  })
}

/** Quote a generated property key as a single-quoted TypeScript string. */
export function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
