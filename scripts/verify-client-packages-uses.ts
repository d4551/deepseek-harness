/**
 * Bare specifier collection for {@link ./verify-client-packages.ts}.
 * Walks TypeScript 7 source files from isolated parse and from TypeScriptProject.
 */
import type { ExportDeclaration, ImportDeclaration, Node, SourceFile } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isLiteralTypeNode,
  isModuleDeclaration,
  isNamespaceExport,
  isNamespaceImport,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import { createSourceFile } from './ts7-session.ts'

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#')
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

function importCarriesRuntimeValue(node: ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined) return true
  if (clause.phaseModifier === SyntaxKind.TypeKeyword) return false
  const bindings = clause.namedBindings
  return clause.name !== undefined
    || bindings === undefined
    || isNamespaceImport(bindings)
    || bindings.elements.length === 0
    || bindings.elements.some(element => !element.isTypeOnly)
}

function exportCarriesRuntimeValue(node: ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  const clause = node.exportClause
  if (clause === undefined || isNamespaceExport(clause)) return true
  return clause.elements.length === 0 || clause.elements.some(element => !element.isTypeOnly)
}

function collectSourceFileUses(
  sourceFile: SourceFile,
  runtimeOnly: boolean,
  key: 'package' | 'specifier',
): Set<string> {
  const uses = new Set<string>()
  const add = (specifier: Node | undefined): void => {
    if (specifier === undefined || !isStringLiteral(specifier) || !isBareSpecifier(specifier.text)) return
    uses.add(key === 'package' ? packageNameOf(specifier.text) : specifier.text)
  }
  const visit = (node: Node): void => {
    if (isImportDeclaration(node)) {
      if (!runtimeOnly || importCarriesRuntimeValue(node)) add(node.moduleSpecifier)
    } else if (isExportDeclaration(node)) {
      if (!runtimeOnly || exportCarriesRuntimeValue(node)) add(node.moduleSpecifier)
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      if (!runtimeOnly || !node.isTypeOnly) add(node.moduleReference.expression)
    } else if (!runtimeOnly && isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
      add(node.argument.literal)
    } else if (isCallExpression(node)
      && (node.expression.kind === SyntaxKind.ImportKeyword
        || isIdentifier(node.expression) && node.expression.text === 'require')) {
      add(node.arguments[0])
    } else if (!runtimeOnly && isModuleDeclaration(node) && isStringLiteral(node.name)) {
      add(node.name)
    } else if (isJsxElement(node) || isJsxSelfClosingElement(node) || isJsxFragment(node)) {
      uses.add('react')
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return uses
}

/**
 * Collect bare packages referenced by one production source file.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @returns Bare package names referenced by imports, declarations, or JSX.
 */
export function collectSourcePackageUses(path: string, source: string): Set<string> {
  return collectSourceFileUses(createSourceFile(path, source), false, 'package')
}

/**
 * Collect bare packages whose values one production source file reaches at runtime.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @returns Bare package names retained by runtime imports, exports, requires, or JSX.
 */
export function collectRuntimeSourcePackageUses(path: string, source: string): Set<string> {
  return collectSourceFileUses(createSourceFile(path, source), true, 'package')
}

/**
 * Collect exact bare specifiers retained by one production source file.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text to inspect.
 * @returns Exact specifiers retained by runtime imports, exports, requires, or JSX.
 */
export function collectRuntimeSourceSpecifiers(path: string, source: string): Set<string> {
  return collectSourceFileUses(createSourceFile(path, source), true, 'specifier')
}

/**
 * Collect uses from an already-parsed TypeScript 7 source file.
 * @param sourceFile - a program source file.
 * @param runtimeOnly - whether type-only imports are ignored.
 * @param key - package name or exact specifier.
 * @returns the collected names.
 */
export function collectParsedSourceFileUses(
  sourceFile: SourceFile,
  runtimeOnly: boolean,
  key: 'package' | 'specifier',
): Set<string> {
  return collectSourceFileUses(sourceFile, runtimeOnly, key)
}
