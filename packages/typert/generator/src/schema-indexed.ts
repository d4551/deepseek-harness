/**
 * Indexed-access resolution over merge-extensible map declarations for Zod
 * schema emission: the workspace convention `ContentBlock =
 * ContentBlockMap[ContentBlockType]` projects to the union of the map's
 * property types, and a literal key projects to that one property.
 */

import type { TypeGraphRenderer } from './renderer.ts'
import type { MemberModel, PropertyMemberModel, SymbolId, TypeNodeModel, TypeNodeId } from './model.ts'

/** Emission targets of one resolvable indexed access. */
export type IndexedAccessTargets =
  | { readonly kind: 'single'; readonly type: TypeNodeId }
  | { readonly kind: 'union'; readonly types: readonly TypeNodeId[] }

type IndexedAccessNode = Extract<TypeNodeModel, { kind: 'indexed-access' }>

/**
 * Resolve one indexed access against its map declaration.
 * @param renderer - face type graph.
 * @param node - authored indexed-access node.
 * @returns the projected member targets, or undefined when the shape is not a
 * data-property map indexed by its own key union or a literal key.
 */
export function indexedAccessTargets(
  renderer: TypeGraphRenderer,
  node: IndexedAccessNode,
): IndexedAccessTargets | undefined {
  const mapNode = renderer.node(node.object)
  if (mapNode.kind !== 'reference' || mapNode.target.kind !== 'declaration') return undefined
  const map = renderer.declaration(mapNode.target.symbol)
  const properties = map.members.filter(isDataProperty)
  if (properties.length === 0) return undefined
  if (isKeyOfReference(renderer, node.index, map.id)) {
    return { kind: 'union', types: properties.map(property => property.type) }
  }
  const index = renderer.node(node.index)
  if (index.kind === 'reference' && index.target.kind === 'declaration') {
    const alias = renderer.declaration(index.target.symbol)
    if (alias.type === undefined) return undefined
    const aliased = renderer.node(alias.type)
    if (aliased.kind === 'operator' && isKeyOfReference(renderer, aliased.type, map.id)) {
      return { kind: 'union', types: properties.map(property => property.type) }
    }
    return undefined
  }
  if (index.kind === 'literal' && typeof index.value === 'string') {
    const member = properties.find(property => property.name === index.value)
    return member === undefined ? undefined : { kind: 'single', type: member.type }
  }
  return undefined
}

function isKeyOfReference(renderer: TypeGraphRenderer, id: TypeNodeId, mapId: SymbolId): boolean {
  const node = renderer.node(id)
  if (node.kind !== 'operator' || node.operator !== 'keyof') return false
  return referencesDeclaration(renderer.node(node.type), mapId)
}

function referencesDeclaration(node: TypeNodeModel, declarationId: SymbolId): boolean {
  return node.kind === 'reference' && node.target.kind === 'declaration' && node.target.symbol === declarationId
}

function isDataProperty(member: MemberModel): member is PropertyMemberModel {
  return member.kind === 'property'
    && !member.static
    && member.visibility === 'public'
    && member.computed === undefined
}
