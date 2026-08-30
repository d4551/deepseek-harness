/**
 * Authored TypeNode conversion and reference targeting.
 */

import type { Node, TypeNode } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import { createNodeArray } from 'typescript/unstable/ast/factory'
import {
  isArrayTypeNode,
  isConditionalTypeNode,
  isConstructorTypeNode,
  isFunctionTypeNode,
  isImportTypeNode,
  isIndexedAccessTypeNode,
  isInferTypeNode,
  isIntersectionTypeNode,
  isLiteralTypeNode,
  isMappedTypeNode,
  isNamedTupleMember,
  isOptionalTypeNode,
  isParenthesizedTypeNode,
  isRestTypeNode,
  isTemplateLiteralTypeNode,
  isThisTypeNode,
  isTupleTypeNode,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeParameterDeclaration,
  isTypePredicateNode,
  isTypeQueryNode,
  isTypeReferenceNode,
  isUnionTypeNode,
} from 'typescript/unstable/ast/is'
import type { Symbol } from 'typescript/unstable/sync'
import type { FaceContext, TypeNodeInput } from './analyzer-context.ts'
import { ensureDeclaration } from './analyzer-decl.ts'
import { isSourceExportTarget, packageExportTargets } from './analyzer-exports.ts'
import { authoredExportName, importForSymbol, moduleSpecifierOf } from './analyzer-imports.ts'
import {
  importTypeModule,
  literalModel,
  modifierMode,
  typeOperatorName,
} from './analyzer-literals.ts'
import { collectMembers, functionSignature, typeParametersOf } from './analyzer-members.ts'
import { externalModuleIdentityForFile, moduleIdentity } from './analyzer-names.ts'
import type { PackageRegistration } from './analyzer-types.ts'
import type { TypeNodeId, TypeTargetModel } from './model.ts'
import { hasModifier, isDefaultLibraryDeclaration, isTypeDeclaration, keywordName, preferredDeclaration } from './ts7-syntax.ts'

/**
 * Convert one authored type node into the compiler-independent graph.
 * @param face - extraction context.
 * @param node - source type node.
 * @returns allocated type-node id.
 */
export function convertType(face: FaceContext, node: TypeNode): TypeNodeId {
  const id = face.allocateNodeId(node)
  const add = (model: TypeNodeInput): TypeNodeId => {
    face.nodes.set(id, { id, ...model })
    return id
  }
  const keyword = keywordName(node.kind)
  if (keyword !== undefined) return add({ kind: 'keyword', name: keyword })
  if (isParenthesizedTypeNode(node)) return add({ kind: 'parenthesized', type: convertType(face, node.type) })
  if (isLiteralTypeNode(node)) return add(literalModel(node))
  if (isTypeReferenceNode(node)) {
    const symbol = face.checker.getSymbolAtLocation(node.typeName)
    if (symbol === undefined) face.fail(node, `type reference ${node.typeName.getText()} has no symbol`)
    return add({
      kind: 'reference',
      name: node.typeName.getText(),
      target: targetForReference(face, face.resolveSymbol(symbol), node),
      arguments: typeArgumentsOf(face, node),
    })
  }
  if (isUnionTypeNode(node) || isIntersectionTypeNode(node)) {
    return add({
      kind: isUnionTypeNode(node) ? 'union' : 'intersection',
      types: node.types.map(type => convertType(face, type)),
    })
  }
  if (isArrayTypeNode(node)) return add({ kind: 'array', element: convertType(face, node.elementType) })
  if (isTupleTypeNode(node)) return add({ kind: 'tuple', elements: tupleElements(face, node) })
  if (isTypeLiteralNode(node)) return add({ kind: 'object', members: collectMembers(face, node.members, id) })
  if (isFunctionTypeNode(node)) return add({ kind: 'function', signature: functionSignature(face, node, node.type) })
  if (isConstructorTypeNode(node)) {
    return add({
      kind: 'constructor',
      abstract: hasModifier(node, SyntaxKind.AbstractKeyword),
      signature: functionSignature(face, node, node.type),
    })
  }
  if (isIndexedAccessTypeNode(node)) {
    return add({
      kind: 'indexed-access',
      object: convertType(face, node.objectType),
      index: convertType(face, node.indexType),
    })
  }
  if (isTypeOperatorNode(node)) {
    return add({
      kind: 'operator',
      operator: typeOperatorName(node.operator),
      type: convertType(face, node.type),
    })
  }
  if (isConditionalTypeNode(node)) {
    return add({
      kind: 'conditional',
      check: convertType(face, node.checkType),
      extends: convertType(face, node.extendsType),
      whenTrue: convertType(face, node.trueType),
      whenFalse: convertType(face, node.falseType),
    })
  }
  if (isInferTypeNode(node)) {
    const parameter = typeParametersOf(face, createNodeArray([node.typeParameter]))[0]
    if (parameter === undefined) face.fail(node, 'infer type is missing its type parameter')
    return add({ kind: 'infer', parameter })
  }
  if (isMappedTypeNode(node)) {
    const parameter = typeParametersOf(face, createNodeArray([node.typeParameter]))[0]
    if (parameter === undefined) face.fail(node, 'mapped type is missing its type parameter')
    return add({
      kind: 'mapped',
      parameter,
      ...node.nameType === undefined ? {} : { nameType: convertType(face, node.nameType) },
      ...node.type === undefined ? {} : { value: convertType(face, node.type) },
      readonly: modifierMode(node.readonlyToken),
      optional: modifierMode(node.questionToken),
    })
  }
  if (isTemplateLiteralTypeNode(node)) {
    return add({
      kind: 'template-literal',
      head: node.head.text,
      spans: node.templateSpans.map(span => ({ type: convertType(face, span.type), text: span.literal.text })),
    })
  }
  if (isTypeQueryNode(node)) {
    return add({
      kind: 'type-query',
      expression: node.exprName.getText(),
      arguments: typeArgumentsOf(face, node),
    })
  }
  if (isImportTypeNode(node)) return add(importTypeModel(face, node))
  if (isTypePredicateNode(node)) {
    return add({
      kind: 'predicate',
      asserts: node.assertsModifier !== undefined,
      parameter: node.parameterName.getText(),
      ...node.type === undefined ? {} : { type: convertType(face, node.type) },
    })
  }
  if (isThisTypeNode(node)) return add({ kind: 'this' })
  face.fail(node, `unsupported TypeScript type node ${SyntaxKind[node.kind]}`)
}

function tupleElements(face: FaceContext, node: import('typescript/unstable/ast').TupleTypeNode) {
  return node.elements.map((element) => {
    const named = isNamedTupleMember(element) ? element : undefined
    const raw = named?.type ?? element
    const optional = named?.questionToken !== undefined || isOptionalTypeNode(raw)
    const rest = named?.dotDotDotToken !== undefined || isRestTypeNode(raw)
    const type = isOptionalTypeNode(raw) || isRestTypeNode(raw) ? raw.type : raw
    return {
      ...named === undefined ? {} : { name: named.name.text },
      type: convertType(face, type),
      optional,
      rest,
    }
  })
}

function importTypeModel(face: FaceContext, node: import('typescript/unstable/ast').ImportTypeNode): TypeNodeInput {
  const symbol = node.qualifier === undefined ? undefined : face.checker.getSymbolAtLocation(node.qualifier)
  return {
    kind: 'import-type',
    module: importTypeModule(node),
    ...node.qualifier === undefined ? {} : { qualifier: node.qualifier.getText() },
    arguments: typeArgumentsOf(face, node),
    typeof: node.isTypeOf,
    ...node.attributes === undefined ? {} : {
      // TS7 ImportAttributes.getText() returns just the object literal; wrap with keyword inside
      attributes: `{ ${node.attributes.token === 117 ? 'with' : 'assert'}: ${node.attributes.getText()} }`,
    },
    ...symbol === undefined ? {} : { target: targetForReference(face, face.resolveSymbol(symbol), node) },
  }
}

/**
 * Convert a type node's type arguments to graph nodes, defaulting to none.
 * @param face - extraction context.
 * @param node - reference, import, or query type node carrying optional type arguments.
 * @returns converted argument node ids.
 */
function typeArgumentsOf(
  face: FaceContext,
  node: import('typescript/unstable/ast').TypeReferenceNode
  | import('typescript/unstable/ast').ImportTypeNode
  | import('typescript/unstable/ast').TypeQueryNode,
): TypeNodeId[] {
  return node.typeArguments?.map(argument => convertType(face, argument)) ?? []
}

/**
 * Resolve a type-reference symbol to a graph target (declaration, cross-face, external).
 * @param face - extraction context.
 * @param symbol - resolved checker symbol.
 * @param site - reference site.
 * @returns the target model.
 */
export function targetForReference(face: FaceContext, symbol: Symbol, site: Node): TypeTargetModel {
  const declaration = preferredDeclaration(symbol, face.project.project)
  if (declaration === undefined) face.fail(site, `type symbol ${symbol.name} has no declaration`)
  if (isTypeParameterDeclaration(declaration)) {
    return { kind: 'type-parameter', parameter: `${face.locationKey(declaration)}#${declaration.name.text}` }
  }
  if (isDefaultLibraryDeclaration(face.project.project, declaration)) {
    return { kind: 'standard', name: symbol.name }
  }
  const from = face.registrationForFile(site.getSourceFile().fileName)
  if (from === undefined) face.fail(site, 'reference site is outside a registered package')
  const owner = face.registrationForFile(declaration.getSourceFile().fileName)
  // Import recovery is symbol-driven: codec projections anchor references
  // whose symbol bears no relation to the authored boundary node's text, so
  // the site's own type name is only a fallback.
  const symbolImport = importForSymbol(site, symbol.name)
  if (owner !== undefined && owner.name !== from.name) {
    if (symbolImport !== undefined) {
      return localTarget(face, symbol, site, declaration, from, owner, moduleIdentity(symbolImport.specifier), symbolImport.exportName)
    }
    const discovered = ownerExportFor(face, owner, symbol)
    if (discovered !== undefined) {
      return localTarget(face, symbol, site, declaration, from, owner, discovered.module, discovered.exportName)
    }
  }
  const authoredSpecifier = moduleSpecifierOf(site)
  const moduleSpecifier = authoredSpecifier ?? symbolImport?.specifier
  const requestedName = authoredSpecifier === undefined
    ? symbolImport?.exportName
    : authoredExportName(site, authoredSpecifier)
  const module = moduleSpecifier === undefined ? undefined : moduleIdentity(moduleSpecifier)
  if (owner !== undefined) {
    return localTarget(face, symbol, site, declaration, from, owner, module, requestedName)
  }
  return externalOrCrossFace(face, symbol, site, from, module, requestedName)
}

/**
 * Find the owner package export subpath that publicly exports one symbol.
 * @param face - extraction context.
 * @param owner - package owning the declaration.
 * @param symbol - referenced symbol.
 * @returns the module identity and exported name, or undefined.
 */
export function ownerExportFor(
  face: FaceContext,
  owner: PackageRegistration,
  symbol: Symbol,
): { readonly module: { readonly package: string; readonly subpath: string }; readonly exportName: string } | undefined {
  let match: { readonly module: { readonly package: string; readonly subpath: string }; readonly exportName: string } | undefined
  for (const [subpath, target] of packageExportTargets(owner.manifest)) {
    if (!isSourceExportTarget(subpath, target)) continue
    const module = { package: owner.name, subpath }
    const exportName = face.packageExportName(module, symbol, owner.face, symbol.name)
    if (exportName === undefined) continue
    // The most specific subpath wins: root entries commonly re-export what a
    // deeper entry also names, and generated import specifiers must point at
    // the entry that actually declares the symbol.
    if (match === undefined || subpath.length > match.module.subpath.length) {
      match = { module, exportName }
    }
  }
  return match
}

function localTarget(
  face: FaceContext,
  symbol: Symbol,
  site: Node,
  declaration: Node,
  from: PackageRegistration,
  owner: PackageRegistration,
  module: ReturnType<typeof moduleIdentity>,
  requestedName: string | undefined,
): TypeTargetModel {
  if (owner.name !== from.name) {
    if (module === undefined || requestedName === undefined) {
      face.fail(site, `reference to ${symbol.name} crosses a package without an explicit package import`)
    }
    if (face.packageExportName(module, symbol, owner.face, requestedName) === undefined) {
      face.fail(site, `package reference ${requestedName} is not exported by ${module.package} at ${module.subpath}`)
    }
  }
  if (!isTypeDeclaration(declaration)) face.fail(site, `reference ${symbol.name} is not a type declaration`)
  if (!face.declarationStates.has(face.symbolId(symbol))) ensureDeclaration(face, symbol, declaration)
  return { kind: 'declaration', symbol: face.symbolId(symbol) }
}

function externalOrCrossFace(
  face: FaceContext,
  symbol: Symbol,
  site: Node,
  from: PackageRegistration,
  module: ReturnType<typeof moduleIdentity>,
  requestedName: string | undefined,
): TypeTargetModel {
  const packageFaces = module === undefined
    ? []
    : [...new Set(face.allRegistrations.filter(candidate => candidate.name === module.package).map(candidate => candidate.face))]
  const otherFace = packageFaces.find(candidate => candidate !== face.face)
  if (otherFace !== undefined && module !== undefined) {
    const requested = requestedName ?? symbol.name
    const exportName = face.packageExportName(module, symbol, otherFace, requested)
    if (exportName === undefined) {
      face.fail(site, `cross-face reference ${requested} is not exported by ${module.package} at ${module.subpath}`)
    }
    face.recordCrossFaceLink(from.name, otherFace, module, exportName)
    return {
      kind: 'cross-face',
      face: otherFace,
      package: module.package,
      subpath: module.subpath,
      name: exportName,
    }
  }
  if (module !== undefined) {
    return { kind: 'external', module: module.package, subpath: module.subpath, name: symbol.name }
  }
  const declaration = preferredDeclaration(symbol, face.project.project)
  const external = declaration === undefined ? undefined : externalModuleIdentityForFile(declaration.getSourceFile().fileName)
  if (external !== undefined) {
    return { kind: 'external', module: external.package, subpath: external.subpath, name: symbol.name }
  }
  face.fail(site, `reference to ${symbol.name} crosses a package or face without an explicit import`)
}
