/**
 * JSON-assignability checks for Remote wire types: every boundary type is
 * walked structurally before a codec is emitted, rejecting class instances,
 * callables, and non-JSON values while accepting compile-time-only markers.
 */

import type { TypeNode } from 'typescript/unstable/ast'
import { isClassDeclaration, isClassExpression } from 'typescript/unstable/ast/is'
import { SignatureKind, SymbolFlags, TypeFlags, type Type } from 'typescript/unstable/sync'
import type { FaceContext } from './analyzer-context.ts'
import { getNumberIndexType, preferredDeclaration, resolveHandle } from './ts7-syntax.ts'

/**
 * Assert one checker type is JSON-transportable on a Remote boundary.
 * @param face - extraction context.
 * @param type - checker type to validate.
 * @param site - authored type node for diagnostics.
 * @param active - types on the current walk path, guarding recursion.
 * @param allowUndefined - whether the boundary admits `undefined`.
 * @param allowVoid - whether the boundary admits `void`.
 */
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
    if (property.name.startsWith('__@')) {
      // `Branded<B>` ids carry their brand as a symbol-keyed property whose
      // type is the brand literal itself: a compile-time-only marker that
      // serializes as the underlying string. Symbol-keyed properties holding
      // real runtime values stay rejected.
      const marker = face.checker.getTypeOfSymbolAtLocation(property, site)
      if ((marker.flags & TypeFlags.StringLiteral) === 0) {
        face.fail(site, 'Remote boundary contains a symbol-keyed property')
      }
      continue
    }
    const siteNode = resolveHandle(property.valueDeclaration, face.project.project)
      ?? resolveHandle(property.declarations[0], face.project.project)
    const owned = face.checker.getTypeOfSymbolAtLocation(property, siteNode ?? site)
    assertRemoteJsonType(face, owned, site, active, (property.flags & SymbolFlags.Optional) !== 0, false)
  }
  active.delete(type)
}

/** Whether one checker type admits `undefined` or `void` at a boundary. */
export function includesRemoteAbsence(type: Type): boolean {
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
