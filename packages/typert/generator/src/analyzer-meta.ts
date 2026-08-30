/**
 * Protocol-module symbol identity for TypertRemoteService, Remote, and maps.
 */

import type { Node } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import { isClassDeclaration, isModuleDeclaration, isStringLiteral } from 'typescript/unstable/ast/is'
import type { Symbol } from 'typescript/unstable/sync'
import type { FaceContext } from './analyzer-context.ts'
import { preferredDeclaration } from './ts7-syntax.ts'

const PROTOCOL_PACKAGE = '@deepseek-ai/dsh-typert-protocol'

/**
 * Whether a name at `node` is the Typert protocol export `name`.
 * @param face - extraction context.
 * @param node - identifier or property access.
 * @param name - protocol export name.
 * @returns true when the symbol resolves to the protocol module.
 */
export function isTypeMetaSymbol(face: FaceContext, node: Node, name: string): boolean {
  const symbol = face.checker.getSymbolAtLocation(node)
  if (symbol === undefined) return false
  const resolved = face.resolveSymbol(symbol)
  if (resolved.name !== name) return false
  const declaration = preferredDeclaration(resolved, face.project.project)
  if (declaration === undefined) return false
  const registration = face.registrationForFile(declaration.getSourceFile().fileName)
  if (registration?.name === PROTOCOL_PACKAGE) return true
  // TS7 declares `parent` non-optional, so the source file is the stop, not undefined.
  for (let current: Node = declaration; current.kind !== SyntaxKind.SourceFile; current = current.parent) {
    if (isModuleDeclaration(current) && isStringLiteral(current.name)
      && current.name.text === PROTOCOL_PACKAGE) return true
  }
  return false
}

/**
 * Whether a symbol is a class declared by a package this face analyzes.
 * @param face - extraction context.
 * @param symbol - symbol to classify.
 * @returns true for a class declaration inside a registered package.
 */
export function isWorkspaceClass(face: FaceContext, symbol: Symbol): boolean {
  const declaration = preferredDeclaration(symbol, face.project.project)
  return declaration !== undefined
    && isClassDeclaration(declaration)
    && face.registrationForFile(declaration.getSourceFile().fileName) !== undefined
}

/**
 * Whether a node is the ambient module declaration for the Typert protocol package.
 * @param node - AST node.
 * @returns true for `declare module '@deepseek-ai/dsh-typert-protocol'`.
 */
export function isProtocolModule(node: Node): boolean {
  return isModuleDeclaration(node)
    && isStringLiteral(node.name)
    && node.name.text === PROTOCOL_PACKAGE
}
