/**
 * Remote wire-type projection and JSON-assignability checks.
 */

import type { Node, TypeNode } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import { isClassDeclaration, isClassExpression, isImportTypeNode, isTypeReferenceNode } from 'typescript/unstable/ast/is'
import { SignatureKind, SymbolFlags, TypeFlags, type Type } from 'typescript/unstable/sync'
import type { FaceContext, TypeNodeInput } from './analyzer-context.ts'
import { convertType } from './analyzer-convert.ts'
import { emptyDocumentation } from './analyzer-docs.ts'
import { packageExportTargets, sourcePathForExport } from './analyzer-exports.ts'
import type { MemberModel, RemoteBoundaryModel, RemoteTypeImportModel, SymbolId, TypeNodeId } from './model.ts'
import { realPath } from './analyzer-util.ts'
import { isDefaultLibraryDeclaration } from './ts7-syntax.ts'
import {
  getNumberIndexType,
  hasModifier,
  preferredDeclaration,
  resolveHandle,
} from './ts7-syntax.ts'

type Absence = 'reject' | 'undefined' | 'undefined-or-void'

/**
 * Project an authored Remote boundary through the face program.
 * @param face - extraction context.
 * @param authoredType - source type node.
 * @param fallbackTypeSymbol - symbol id when the type is anonymous.
 * @param requireNamed - reject anonymous types.
 * @param topLevelAbsence - how omitted wire values are modeled.
 * @param optional - treat the authored type as `| undefined`.
 * @returns the boundary model.
 */
export function remoteBoundary(
  face: FaceContext,
  authoredType: TypeNode,
  fallbackTypeSymbol: string,
  requireNamed: boolean,
  topLevelAbsence: Absence = 'reject',
  optional = false,
): RemoteBoundaryModel {
  const type = convertType(face, authoredType)
  const declaredType = face.checker.getTypeFromTypeNode(authoredType)
  if (declaredType === undefined) face.fail(authoredType, 'Remote boundary has no checker type')
  const codecType = resolvedRemoteCodecType(face, authoredType, declaredType, topLevelAbsence)
  const acceptsUndefined = topLevelAbsence !== 'reject'
    && (optional || includesRemoteAbsence(declaredType))
  const rootSymbol = namedWorkspaceType(face, authoredType)
  const imports = collectRemoteImports(face, authoredType)
  if (rootSymbol !== undefined) {
    const imported = publicRemoteType(face, rootSymbol, authoredType)
    return {
      type,
      codecType: optional ? unionWithUndefined(face, authoredType, codecType) : codecType,
      acceptsUndefined,
      typeSymbol: `${imported.specifier}#${imported.name}`,
      imports,
    }
  }
  if (requireNamed) face.fail(authoredType, 'lookup and Context wire types must be named public types')
  return {
    type,
    codecType: optional ? unionWithUndefined(face, authoredType, codecType) : codecType,
    acceptsUndefined,
    typeSymbol: fallbackTypeSymbol,
    imports,
  }
}

function unionWithUndefined(face: FaceContext, site: TypeNode, member: TypeNodeId): TypeNodeId {
  const undefinedId = face.addNode(site, { kind: 'keyword', name: 'undefined' })
  return face.addNode(site, { kind: 'union', types: [member, undefinedId] })
}

export function resolvedRemoteCodecType(
  face: FaceContext,
  authoredType: TypeNode,
  resolvedType: Type,
  topLevelAbsence: Absence,
): TypeNodeId {
  assertRemoteJsonType(face, resolvedType, authoredType, new Set(), topLevelAbsence !== 'reject', topLevelAbsence === 'undefined-or-void')
  const completed = new Map<Type, TypeNodeId>()
  const active = new Map<Type, TypeNodeId>()
  const convert = (type: Type): TypeNodeId => codecConvert(face, authoredType, type, completed, active, convert)
  return convert(resolvedType)
}

function codecConvert(
  face: FaceContext,
  authoredType: TypeNode,
  type: Type,
  completed: Map<Type, TypeNodeId>,
  active: Map<Type, TypeNodeId>,
  convert: (type: Type) => TypeNodeId,
): TypeNodeId {
  const cached = completed.get(type)
  if (cached !== undefined) return cached
  const activeId = active.get(type)
  if (activeId !== undefined) return activeId
  const id = face.allocateNodeId(authoredType)
  active.set(type, id)
  const model = codecModel(face, type, authoredType, convert, id)
  face.nodes.set(id, { id, ...model })
  completed.set(type, id)
  active.delete(type)
  return id
}

function codecModel(
  face: FaceContext,
  type: Type,
  authoredType: TypeNode,
  convert: (type: Type) => TypeNodeId,
  id: TypeNodeId,
): TypeNodeInput {
  const flags = type.flags
  if ((flags & TypeFlags.Any) !== 0) return { kind: 'keyword', name: 'any' }
  if ((flags & TypeFlags.Unknown) !== 0) return { kind: 'keyword', name: 'unknown' }
  if ((flags & TypeFlags.Never) !== 0) return { kind: 'keyword', name: 'never' }
  if ((flags & TypeFlags.String) !== 0) return { kind: 'keyword', name: 'string' }
  if ((flags & TypeFlags.Number) !== 0) return { kind: 'keyword', name: 'number' }
  if ((flags & TypeFlags.BigInt) !== 0) return { kind: 'keyword', name: 'bigint' }
  if ((flags & TypeFlags.Boolean) !== 0) return { kind: 'keyword', name: 'boolean' }
  if ((flags & TypeFlags.ESSymbol) !== 0) return { kind: 'keyword', name: 'symbol' }
  if ((flags & TypeFlags.Undefined) !== 0) return { kind: 'keyword', name: 'undefined' }
  if ((flags & TypeFlags.Void) !== 0) return { kind: 'keyword', name: 'void' }
  if ((flags & TypeFlags.Null) !== 0) return { kind: 'literal', value: null, text: 'null' }
  if ((flags & TypeFlags.StringLiteral) !== 0 && type.isStringLiteralType()) {
    return { kind: 'literal', value: type.value, text: quoted(type.value) }
  }
  if ((flags & TypeFlags.NumberLiteral) !== 0 && type.isNumberLiteralType()) {
    return { kind: 'literal', value: type.value, text: String(type.value) }
  }
  if ((flags & TypeFlags.BigIntLiteral) !== 0 && type.isBigIntLiteralType()) {
    return { kind: 'literal', value: type.value, text: `${String(type.value)}n` }
  }
  if ((flags & TypeFlags.BooleanLiteral) !== 0 && type.isBooleanLiteralType()) {
    return { kind: 'literal', value: type.value, text: String(type.value) }
  }
  if (type.isUnionType() || type.isIntersectionType()) {
    return { kind: type.isUnionType() ? 'union' : 'intersection', types: type.getTypes().map(convert) }
  }
  if ((flags & TypeFlags.TypeParameter) !== 0) face.fail(authoredType, 'Remote codec contains an unresolved type parameter')
  if ((flags & TypeFlags.Object) === 0) {
    face.fail(authoredType, `Remote codec type ${face.checker.typeToString(type)} has no concrete Zod projection`)
  }
  if (face.checker.isArrayType(type) || face.checker.isArrayLikeType(type)) {
    const element = getNumberIndexType(face.checker, type)
    if (element === undefined) face.fail(authoredType, 'Remote codec array has no element type')
    return { kind: 'array', element: convert(element) }
  }
  if (face.checker.getSignaturesOfType(type, SignatureKind.Call).length > 0
    || face.checker.getSignaturesOfType(type, SignatureKind.Construct).length > 0) {
    face.fail(authoredType, 'Remote codec cannot contain callable or constructable values')
  }
  return { kind: 'object', members: codecProperties(face, type, authoredType, convert, id) }
}

function codecProperties(
  face: FaceContext,
  type: Type,
  authoredType: TypeNode,
  convert: (type: Type) => TypeNodeId,
  id: TypeNodeId,
): MemberModel[] {
  const members: MemberModel[] = []
  for (const property of face.checker.getPropertiesOfType(type)) {
    const site = resolveHandle(property.valueDeclaration, face.project.project)
      ?? resolveHandle(property.declarations[0], face.project.project)
    const owned = face.checker.getTypeOfSymbolAtLocation(property, site ?? authoredType)
    members.push({
      ...emptyDocumentation(),
      id: `${id}#${property.name}`,
      name: property.name,
      ...property.name.startsWith('__@') ? { computed: 'symbol' as const } : {},
      optional: (property.flags & SymbolFlags.Optional) !== 0,
      readonly: site !== undefined && hasModifier(site, SyntaxKind.ReadonlyKeyword),
      async: false,
      abstract: false,
      static: false,
      visibility: 'public',
      location: face.location(authoredType),
      text: '',
      kind: 'property',
      type: convert(owned),
    })
  }
  return members
}

export function assertRemoteJsonType(
  face: FaceContext,
  type: Type,
  site: TypeNode,
  active: Set<Type>,
  allowUndefined: boolean,
  allowVoid: boolean,
) {
  const flags = type.flags
  if ((flags & TypeFlags.Undefined) !== 0 && allowUndefined) return
  if ((flags & TypeFlags.Void) !== 0 && allowVoid) return
  if ((flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
    face.fail(site, `Remote boundary contains unconstrained ${face.checker.typeToString(type)} data`)
  }
  if ((flags & (TypeFlags.BigIntLike | TypeFlags.ESSymbolLike | TypeFlags.Undefined | TypeFlags.Void)) !== 0) {
    face.fail(site, `Remote boundary contains non-JSON type ${face.checker.typeToString(type)}`)
  }
  if ((flags & (TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.BooleanLike | TypeFlags.Null | TypeFlags.Never)) !== 0) return
  if (type.isUnionType()) {
    for (const member of type.getTypes()) assertRemoteJsonType(face, member, site, active, allowUndefined, allowVoid)
    return
  }
  if (type.isIntersectionType()) {
    const material = type.getTypes().filter(member => !isRemotePhantomConstraint(face, member))
    if (material.length === 0) face.fail(site, 'Remote boundary contains a symbol-only object')
    for (const member of material) assertRemoteJsonType(face, member, site, active, false, false)
    return
  }
  if ((flags & TypeFlags.TypeParameter) !== 0) face.fail(site, 'Remote boundary contains an unresolved type parameter')
  if ((flags & TypeFlags.Object) === 0) {
    face.fail(site, `Remote boundary contains non-JSON type ${face.checker.typeToString(type)}`)
  }
  walkObjectJson(face, type, site, active)
}

function walkObjectJson(face: FaceContext, type: Type, site: TypeNode, active: Set<Type>) {
  const symbol = type.getSymbol()
  const declaration = symbol === undefined ? undefined : preferredDeclaration(symbol, face.project.project)
  if (declaration !== undefined && (isClassDeclaration(declaration) || isClassExpression(declaration))) {
    face.fail(site, `Remote boundary contains class instance ${symbol?.name ?? face.checker.typeToString(type)}`)
  }
  if (face.checker.getSignaturesOfType(type, SignatureKind.Call).length > 0
    || face.checker.getSignaturesOfType(type, SignatureKind.Construct).length > 0) {
    face.fail(site, 'Remote boundary contains callable or constructable data')
  }
  if (active.has(type)) return
  active.add(type)
  if (face.checker.isArrayType(type) || face.checker.isArrayLikeType(type)) {
    const element = getNumberIndexType(face.checker, type)
    if (element === undefined) face.fail(site, 'Remote boundary array has no element type')
    assertRemoteJsonType(face, element, site, active, false, false)
    active.delete(type)
    return
  }
  for (const property of face.checker.getPropertiesOfType(type)) {
    if (property.name.startsWith('__@')) face.fail(site, 'Remote boundary contains a symbol-keyed property')
    const siteNode = resolveHandle(property.valueDeclaration, face.project.project)
      ?? resolveHandle(property.declarations[0], face.project.project)
    const owned = face.checker.getTypeOfSymbolAtLocation(property, siteNode ?? site)
    assertRemoteJsonType(face, owned, site, active, (property.flags & SymbolFlags.Optional) !== 0, false)
  }
  active.delete(type)
}

function includesRemoteAbsence(type: Type): boolean {
  if ((type.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0) return true
  if (type.isUnionType()) return type.getTypes().some(member => includesRemoteAbsence(member))
  return false
}

function isRemotePhantomConstraint(face: FaceContext, type: Type): boolean {
  if ((type.flags & TypeFlags.Unknown) !== 0) return true
  if ((type.flags & TypeFlags.Any) !== 0 || (type.flags & TypeFlags.Object) === 0) return false
  return face.checker.getPropertiesOfType(type).length === 0
    && face.checker.getIndexInfosOfType(type).length === 0
    && face.checker.getSignaturesOfType(type, SignatureKind.Call).length === 0
}

function namedWorkspaceType(face: FaceContext, node: TypeNode) {
  const symbol = face.symbolAtType(node)
  if (symbol === undefined) return undefined
  const declaration = preferredDeclaration(symbol, face.project.project)
  if (declaration === undefined || isDefaultLibraryDeclaration(face.project.project, declaration)) return undefined
  if (face.registrationForFile(declaration.getSourceFile().fileName) === undefined) return undefined
  return symbol
}

function publicRemoteType(face: FaceContext, symbol: import('typescript/unstable/sync').Symbol, site: Node): RemoteTypeImportModel {
  const declaration = preferredDeclaration(symbol, face.project.project)
  if (declaration === undefined) face.fail(site, `remote type ${symbol.name} has no declaration`)
  const owner = face.registrationForFile(declaration.getSourceFile().fileName)
  if (owner === undefined) face.fail(site, `remote type ${symbol.name} is not a workspace export`)
  const file = realPath(declaration.getSourceFile().fileName)
  const subpath = packageExportTargets(owner.manifest)
    .filter(([, target]) => realPath(sourcePathForExport(owner.root, target)) === file)
    .map(([candidate]) => candidate)
    .sort((left, right) => right.length - left.length)[0]
  if (subpath === undefined) face.fail(site, `remote type ${symbol.name} is not exported by ${owner.name}`)
  return {
    symbol: face.symbolId(symbol),
    specifier: subpath === '.' ? owner.name : `${owner.name}${subpath.slice(1)}`,
    name: symbol.name,
  }
}

function collectRemoteImports(face: FaceContext, authoredType: TypeNode): RemoteTypeImportModel[] {
  const imports = new Map<SymbolId, RemoteTypeImportModel>()
  const visit = (node: Node) => {
    if (isTypeReferenceNode(node) || isImportTypeNode(node)) {
      const symbol = isTypeReferenceNode(node)
        ? face.checker.getSymbolAtLocation(node.typeName)
        : node.qualifier === undefined ? undefined : face.checker.getSymbolAtLocation(node.qualifier)
      if (symbol !== undefined) {
        const resolved = face.resolveSymbol(symbol)
        const declaration = preferredDeclaration(resolved, face.project.project)
        if (declaration !== undefined
          && !isDefaultLibraryDeclaration(face.project.project, declaration)
          && face.registrationForFile(declaration.getSourceFile().fileName) !== undefined) {
          const imported = publicRemoteType(face, resolved, node)
          imports.set(imported.symbol, imported)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(authoredType)
  return [...imports.values()].sort((left, right) =>
    left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))
}

function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
