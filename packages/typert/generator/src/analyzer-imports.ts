/**
 * Recover the import specifier and exported name for a type reference site.
 */

import type { Expression, Node, TypeNode } from 'typescript/unstable/ast'
import {
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isNamedImports,
  isNamespaceImport,
  isStringLiteral,
  isTypeReferenceNode,
} from 'typescript/unstable/ast/is'
import { TypertAnalysisError } from './analyzer-error.ts'
import { importTypeModule } from './analyzer-literals.ts'

export type ReferenceSite = TypeNode | import('typescript/unstable/ast').ExpressionWithTypeArguments

export function moduleSpecifierOf(node: Node): string | undefined {
  if (isImportTypeNode(node)) return importTypeModule(node)
  let first: string | undefined
  if (isTypeReferenceNode(node)) {
    first = isIdentifier(node.typeName) ? node.typeName.text : node.typeName.getText().split('.')[0]
  } else if ('expression' in node) {
    const expression = node.expression
    if (expression === undefined || typeof expression !== 'object') return undefined
    first = 'text' in expression && typeof expression.text === 'string'
      ? expression.text
      : (expression as Expression).getText().split('.')[0]
  }
  if (first === undefined) return undefined
  const sourceFile = node.getSourceFile()
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement) || statement.importClause === undefined
      || !isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.importClause.name?.text === first) return statement.moduleSpecifier.text
    const bindings = statement.importClause.namedBindings
    if (bindings !== undefined && isNamespaceImport(bindings) && bindings.name.text === first) {
      return statement.moduleSpecifier.text
    }
    if (bindings !== undefined && isNamedImports(bindings)
      && bindings.elements.some(element => element.name.text === first)) return statement.moduleSpecifier.text
  }
  return undefined
}

export function authoredExportName(node: Node, moduleSpecifier: string): string {
  if (isImportTypeNode(node)) {
    return node.qualifier === undefined ? 'default' : node.qualifier.getText().split('.')[0] ?? 'default'
  }
  const referenced = isTypeReferenceNode(node)
    ? node.typeName.getText().split('.')
    : 'expression' in node && node.expression !== undefined && typeof node.expression === 'object'
      ? (node.expression as Expression).getText().split('.')
      : []
  const localName = referenced[0] ?? ''
  for (const statement of node.getSourceFile().statements) {
    if (!isImportDeclaration(statement)
      || statement.importClause === undefined
      || !isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier) continue
    if (statement.importClause.name?.text === localName) return 'default'
    const bindings = statement.importClause.namedBindings
    if (bindings !== undefined && isNamedImports(bindings)) {
      const imported = bindings.elements.find(element => element.name.text === localName)
      if (imported !== undefined) return imported.propertyName?.text ?? imported.name.text
    }
    if (bindings !== undefined && isNamespaceImport(bindings) && bindings.name.text === localName) {
      return referenced[1] ?? localName
    }
  }
  throw new TypertAnalysisError(`typert: cannot recover export name for ${localName} from ${moduleSpecifier}`)
}

export function isLiteralTypeImportArgument(node: Node): node is import('typescript/unstable/ast').LiteralTypeNode {
  return isLiteralTypeNode(node)
}
