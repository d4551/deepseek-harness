/**
 * TypeScript 7 AST helpers replacing Strada `ts.is*` name differences,
 * NodeHandle resolution, modifiers, and checker gaps.
 */

import type { Decorator, ModifierLike, Node, SourceFile } from 'typescript/unstable/ast'
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

/**
 * Whether a node declares a type Typert can extract.
 * @param node - AST node.
 * @returns true for a class, interface, type alias, or enum declaration.
 */
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

/**
 * Modifier list of any node that carries one. TS7 declares `modifiers` on
 * `ModifiersBase` but exports no predicate for it, so the property is read
 * through that declared type.
 * @param node - AST node.
 * @returns the declared modifiers, empty when the node carries none.
 */
function modifierList(node: Node): readonly ModifierLike[] {
  return (node as { readonly modifiers?: readonly ModifierLike[] }).modifiers ?? []
}

/**
 * Whether a node carries one modifier keyword.
 * @param node - AST node.
 * @param kind - modifier keyword to look for.
 * @returns true when the node declares that modifier.
 */
export function hasModifier(node: Node, kind: SyntaxKind): boolean {
  return modifierList(node).some(modifier => isModifierLike(modifier) && modifier.kind === kind)
}

/**
 * Whether a named member is declared optional.
 * @param node - AST node.
 * @returns true for a named member whose postfix token is `?`.
 */
export function isOptionalMember(node: Node): boolean {
  if (!isNamedMember(node)) return false
  return node.postfixToken?.kind === SyntaxKind.QuestionToken
}

/**
 * Decorators a node carries.
 * @param node - AST node.
 * @returns the decorators in declaration order, empty when the node has none.
 */
export function decoratorsOf(node: Node): readonly Decorator[] {
  return modifierList(node).filter(modifier => isDecorator(modifier))
}

/**
 * Read a value taken off an AST node back as a Node. TS7 exports no
 * "is an AST node" predicate, so the structural test is the available one.
 * @param value - value read from a node property.
 * @returns the value as a Node, or undefined when it is not one.
 */
export function asNode(value: unknown): Node | undefined {
  return value !== null && typeof value === 'object' && 'kind' in value && 'getText' in value
    ? value as Node
    : undefined
}

/**
 * Declared visibility of a class or type member.
 * @param node - AST node.
 * @returns `private` for a `#name` or `private` member, `protected` for a
 *   `protected` member, `public` otherwise.
 */
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

/**
 * The model name of a keyword type.
 * @param kind - syntax kind of a type node.
 * @returns the keyword name, or undefined when the kind is not a keyword type.
 */
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

/**
 * Whether a node introduces a class body.
 * @param node - AST node.
 * @returns true for a class declaration or class expression.
 */
export function isClassLike(node: Node): boolean {
  return isClassDeclaration(node) || isClassExpression(node)
}

/**
 * The text of an identifier node.
 * @param node - candidate node, or undefined.
 * @returns the identifier text, undefined for any other node.
 */
export function identifierText(node: Node | undefined): string | undefined {
  return node !== undefined && isIdentifier(node) ? node.text : undefined
}

/**
 * The file a node was parsed from.
 * @param node - node bound in a program.
 * @returns its source file.
 */
export function sourceFileOf(node: Node): SourceFile {
  return node.getSourceFile()
}
