/**
 * TypeScript 7 AST helpers replacing Strada `ts.is*` name differences,
 * NodeHandle resolution, modifiers, and checker gaps.
 */

import type { Decorator, Node, SourceFile } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isEnumDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isModifierLike,
  isPrivateIdentifier,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isTypeAliasDeclaration,
} from 'typescript/unstable/ast/is'
import { TypeFlags, type Checker, type NodeHandle, type Project, type Symbol, type Type } from 'typescript/unstable/sync'
import type { KeywordTypeName, MemberVisibility } from './model.ts'

/** Class, interface, alias, or enum declaration. */
export type TypeDeclaration = import('typescript/unstable/ast').ClassDeclaration
  | import('typescript/unstable/ast').InterfaceDeclaration
  | import('typescript/unstable/ast').TypeAliasDeclaration
  | import('typescript/unstable/ast').EnumDeclaration

/** Property, method, accessor, or signature member carrying a `name`. */
export type NamedMemberDeclaration = import('typescript/unstable/ast').PropertyDeclaration
  | import('typescript/unstable/ast').MethodDeclaration
  | import('typescript/unstable/ast').GetAccessorDeclaration
  | import('typescript/unstable/ast').SetAccessorDeclaration
  | import('typescript/unstable/ast').PropertySignatureDeclaration
  | import('typescript/unstable/ast').MethodSignatureDeclaration

/**
 * Whether a node is a class or type member that carries a `name`.
 * @param node - AST node.
 * @returns true for named members.
 */
export function isNamedMember(node: Node): node is NamedMemberDeclaration {
  return isPropertyDeclaration(node) || isMethodDeclaration(node)
    || isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)
    || isPropertySignatureDeclaration(node) || isMethodSignatureDeclaration(node)
}

/**
 * Resolve a NodeHandle against the project that produced it.
 * @param handle - declaration handle, or undefined.
 * @param project - owning TypeScript 7 project.
 * @returns the bound AST node.
 */
export function resolveHandle(handle: NodeHandle | undefined, project: Project): Node | undefined {
  if (handle === undefined) return undefined
  return handle.resolve(project)
}

/**
 * Resolve every declaration handle on a symbol.
 * @param symbol - checker symbol.
 * @param project - owning TypeScript 7 project.
 * @returns bound declaration nodes, skipping unresolved handles.
 */
export function resolveDeclarations(symbol: Symbol, project: Project): Node[] {
  const nodes: Node[] = []
  for (const handle of symbol.declarations) {
    const node = handle.resolve(project)
    if (node !== undefined) nodes.push(node)
  }
  return nodes
}

export function isTypeDeclaration(node: Node): node is TypeDeclaration {
  return isClassDeclaration(node)
    || isInterfaceDeclaration(node)
    || isTypeAliasDeclaration(node)
    || isEnumDeclaration(node)
}

/**
 * Whether a resolved declaration lives in a compiler default library file,
 * using the TypeScript 7 program's own classification instead of path
 * patterns, which do not match the native compiler's library layout.
 * @param project - owning TypeScript 7 project.
 * @param declaration - resolved declaration node.
 * @returns true when the declaring source file is a default library.
 */
export function isDefaultLibraryDeclaration(project: Project, declaration: Node): boolean {
  return project.program.isSourceFileDefaultLibrary(declaration.getSourceFile())
}

/**
 * Prefer a named type declaration, then the value declaration, then the first
 * resolved handle.
 * @param symbol - checker symbol.
 * @param project - owning TypeScript 7 project.
 * @returns a declaration node when one resolves.
 */
export function preferredDeclaration(symbol: Symbol, project: Project): Node | undefined {
  for (const node of resolveDeclarations(symbol, project)) {
    if (isTypeDeclaration(node)) return node
  }
  const value = resolveHandle(symbol.valueDeclaration, project)
  if (value !== undefined) return value
  return resolveDeclarations(symbol, project)[0]
}

export function hasModifier(node: Node, kind: SyntaxKind): boolean {
  if (!('modifiers' in node) || !Array.isArray(node.modifiers)) return false
  for (const modifier of node.modifiers) {
    if (isModifierLike(modifier) && modifier.kind === kind) return true
  }
  return false
}

export function isOptionalMember(node: Node): boolean {
  if (!isNamedMember(node)) return false
  return node.postfixToken?.kind === SyntaxKind.QuestionToken
}

export function decoratorsOf(node: Node): readonly Decorator[] {
  if (!('modifiers' in node) || !Array.isArray(node.modifiers)) return []
  const result: Decorator[] = []
  for (const modifier of node.modifiers) {
    if (isDecorator(modifier)) result.push(modifier)
  }
  return result
}

export function visibilityOf(node: Node): MemberVisibility {
  if (isNamedMember(node) && isPrivateIdentifier(node.name)) return 'private'
  if (hasModifier(node, SyntaxKind.PrivateKeyword)) return 'private'
  if (hasModifier(node, SyntaxKind.ProtectedKeyword)) return 'protected'
  return 'public'
}

/**
 * Number-index element type, replacing Strada `getIndexTypeOfType(..., Number)`.
 * @param checker - project checker.
 * @param type - array, tuple, or indexed object.
 * @returns the element type when one exists.
 */
export function getNumberIndexType(checker: Checker, type: Type): Type | undefined {
  for (const info of checker.getIndexInfosOfType(type)) {
    if ((info.keyType.flags & TypeFlags.NumberLike) !== 0) return info.valueType
  }
  if (type.isTypeReference()) {
    const args = checker.getTypeArguments(type)
    if (args[0] !== undefined && (checker.isArrayType(type) || checker.isArrayLikeType(type))) return args[0]
  }
  return undefined
}

export function keywordName(kind: SyntaxKind): KeywordTypeName | undefined {
  switch (kind) {
    case SyntaxKind.AnyKeyword: return 'any'
    case SyntaxKind.BigIntKeyword: return 'bigint'
    case SyntaxKind.BooleanKeyword: return 'boolean'
    case SyntaxKind.NeverKeyword: return 'never'
    case SyntaxKind.NumberKeyword: return 'number'
    case SyntaxKind.ObjectKeyword: return 'object'
    case SyntaxKind.StringKeyword: return 'string'
    case SyntaxKind.SymbolKeyword: return 'symbol'
    case SyntaxKind.UndefinedKeyword: return 'undefined'
    case SyntaxKind.UnknownKeyword: return 'unknown'
    case SyntaxKind.VoidKeyword: return 'void'
    default: return undefined
  }
}

export function isClassLike(node: Node): boolean {
  return isClassDeclaration(node) || isClassExpression(node)
}

export function identifierText(node: Node | undefined): string | undefined {
  return node !== undefined && isIdentifier(node) ? node.text : undefined
}

export function sourceFileOf(node: Node): SourceFile {
  return node.getSourceFile()
}
