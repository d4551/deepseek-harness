/**
 * Fixture-module import specifiers for {@link ./verify-cordis-config.ts}.
 * Isolated TypeScript 7 parse; no Strada preprocessor.
 */

import type { Node } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isExternalModuleReference,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import { createSourceFile } from './ts7-session.ts'

function specifierText(node: Node | undefined): string | undefined {
  if (node === undefined || !isStringLiteral(node)) return undefined
  return node.text
}

/**
 * Collect module specifiers a fixture file imports or re-exports.
 * @param fileName - path used as the source-file name.
 * @param source - file contents.
 * @returns specifier strings in visit order.
 */
export function collectImportedSpecifiers(fileName: string, source: string): string[] {
  const sourceFile = createSourceFile(fileName, source)
  const specifiers: string[] = []
  const pushSpecifier = (node: Node | undefined): void => {
    const text = specifierText(node)
    if (text !== undefined) specifiers.push(text)
  }
  const visit = (node: Node) => {
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      pushSpecifier(node.moduleSpecifier)
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      pushSpecifier(node.moduleReference.expression)
    } else if (isCallExpression(node)
      && (node.expression.kind === SyntaxKind.ImportKeyword
        || isIdentifier(node.expression) && node.expression.text === 'require')) {
      pushSpecifier(node.arguments[0])
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return specifiers
}
