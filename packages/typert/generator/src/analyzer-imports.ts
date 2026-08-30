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
import { asNode } from './ts7-syntax.ts'

/** A node that can carry a type reference: an authored type node or a heritage clause entry. */
export type ReferenceSite = TypeNode | import('typescript/unstable/ast').ExpressionWithTypeArguments

/**
 * The module a reference site imports its root name from.
 * @param node - reference site.
 * @returns the import specifier, or undefined when the name is declared locally.
 */
export function moduleSpecifierOf(node: Node): string | undefined {
  if (isImportTypeNode(node)) return importTypeModule(node)
  let first: string | undefined
  if (isTypeReferenceNode(node)) {
    first = isIdentifier(node.typeName) ? node.typeName.text : node.typeName.getText().split('.')[0]
  } else if ('expression' in node) {
    const expression = asNode(node.expression)
    if (expression === undefined) return undefined
    const text: unknown = Reflect.get(expression, 'text')
    first = typeof text === 'string' ? text : expression.getText().split('.')[0]
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

/**
 * Recover the import that brings `symbolName` into the site's file when the
 * authored node names a different identifier — codec projections evaluate
 * nested references against the outermost authored type node, so the site's
 * own text (e.g. `Promise<…>`) does not name the referenced symbol.
 * @param site - reference site whose source file holds the import.
 * @param symbolName - resolved symbol name to locate among imports.
 * @returns the module specifier and exported name, or undefined.
 */
export function importForSymbol(site: Node, symbolName: string): { readonly specifier: string; readonly exportName: string } | undefined {
  for (const statement of site.getSourceFile().statements) {
    if (!isImportDeclaration(statement) || statement.importClause === undefined
      || !isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.importClause.name?.text === symbolName) {
      return { specifier: statement.moduleSpecifier.text, exportName: 'default' }
    }
    const bindings = statement.importClause.namedBindings
    if (bindings !== undefined && isNamedImports(bindings)) {
      const element = bindings.elements.find(candidate =>
        candidate.name.text === symbolName || candidate.propertyName?.text === symbolName)
      if (element !== undefined) {
        return { specifier: statement.moduleSpecifier.text, exportName: element.propertyName?.text ?? element.name.text }
      }
    }
  }
  return undefined
}

/**
 * The name a module exports the reference under, recovered from the import
 * that brought its local name in.
 * @param node - reference site.
 * @param moduleSpecifier - module the name was imported from.
 * @returns the exported name, `default` for a default import.
 * @throws TypertAnalysisError when no import in the file binds that name.
 */
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

/**
 * Whether an `import(...)` type argument is a literal type node.
 * @param node - the import type's argument.
 * @returns true for a literal type node.
 */
export function isLiteralTypeImportArgument(node: Node): node is import('typescript/unstable/ast').LiteralTypeNode {
  return isLiteralTypeNode(node)
}
