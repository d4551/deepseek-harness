/**
 * TypeScript 7 AST helpers replacing Strada `ts.is*` name differences,
 * NodeHandle resolution, modifiers, and checker gaps.
 */

import type { Decorator, Node, SourceFile, TypeNode } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isEnumDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isPrivateIdentifier,
  isTypeAliasDeclaration,
} from 'typescript/unstable/ast/is'
import {
  createKeywordTypeNode,
  createUnionTypeNode,
} from 'typescript/unstable/ast/factory'
import type { Checker, NodeHandle, Project, Symbol, Type } from 'typescript/unstable/sync'
import { TypeFlags } from 'typescript/unstable/sync'
import type { KeywordTypeName, MemberVisibility } from './model.ts'

/** Class, interface, alias, or enum declaration. */
export type TypeDeclaration = import('typescript/unstable/ast').ClassDeclaration
  | import('typescript/unstable/ast').InterfaceDeclaration
  | import('typescript/unstable/ast').TypeAliasDeclaration
  | import('typescript/unstable/ast').EnumDeclaration

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
  if (!('modifiers' in node) || node.modifiers === undefined) return false
  for (const modifier of node.modifiers) {
    if (modifier.kind === kind) return true
  }
  return false
}

export function isOptionalMember(node: Node): boolean {
  if ('questionToken' in node && node.questionToken !== undefined) return true
  if (!('postfixToken' in node) || node.postfixToken === undefined) return false
  return node.postfixToken.kind === SyntaxKind.QuestionToken
}

export function decoratorsOf(node: Node): readonly Decorator[] {
  if (!('modifiers' in node) || node.modifiers === undefined) return []
  const result: Decorator[] = []
  for (const modifier of node.modifiers) {
    if (isDecorator(modifier)) result.push(modifier)
  }
  return result
}

export function visibilityOf(node: Node): MemberVisibility {
  if ('name' in node && node.name !== undefined && isPrivateIdentifier(node.name)) return 'private'
  if (hasModifier(node, SyntaxKind.PrivateKeyword)) return 'private'
  if (hasModifier(node, SyntaxKind.ProtectedKeyword)) return 'protected'
  return 'public'
}

/**
 * Union `type` with `undefined` the way Strada `getNullableType` did.
 * @param checker - project checker.
 * @param type - declared type that may already include undefined.
 * @returns a type that accepts undefined.
 */
export function getNullableType(checker: Checker, type: Type): Type {
  if ((type.flags & TypeFlags.Undefined) !== 0) return type
  if (type.isUnionType() && type.getTypes().some(part => (part.flags & TypeFlags.Undefined) !== 0)) return type
  const node = checker.typeToTypeNode(type)
  if (node === undefined) return type
  const union: TypeNode = createUnionTypeNode([node, createKeywordTypeNode(SyntaxKind.UndefinedKeyword)])
  return checker.getTypeFromTypeNode(union) ?? type
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
