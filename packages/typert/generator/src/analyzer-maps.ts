/**
 * TypertLookupMap and TypertContextMap members from the protocol module.
 */

import type { TypeElement } from 'typescript/unstable/ast'
import {
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeReferenceNode,
} from 'typescript/unstable/ast/is'
import type { FaceContext } from './analyzer-context.ts'
import { memberName } from './analyzer-docs.ts'
import { isTypeMetaSymbol } from './analyzer-meta.ts'
import { isRemoteSegment } from './analyzer-names.ts'
import type { StaticMapEntry } from './analyzer-remote-types.ts'
import type { SymbolId } from './model.ts'

/**
 * Lookup-map entries, memoized on the face context.
 * @param face - extraction context.
 * @returns TypertLookupMap members.
 */
export function lookupDeclarations(face: FaceContext): readonly StaticMapEntry[] {
  if (face.lookups !== undefined) return face.lookups
  const byKey = new Map<string, StaticMapEntry>()
  const byHost = new Map<SymbolId, StaticMapEntry>()
  for (const declaration of protocolMembers(face, 'TypertLookupMap')) {
    addLookup(face, declaration, byKey, byHost)
  }
  face.lookups = [...byKey.values()]
  return face.lookups
}

/**
 * Context-map entries, memoized on the face context.
 * @param face - extraction context.
 * @returns TypertContextMap members keyed by Context name.
 */
export function contextDeclarations(face: FaceContext): ReadonlyMap<string, StaticMapEntry> {
  if (face.contexts !== undefined) return face.contexts
  const result = new Map<string, StaticMapEntry>()
  for (const declaration of protocolMembers(face, 'TypertContextMap')) {
    addContext(face, declaration, result)
  }
  face.contexts = result
  return result
}

function addLookup(
  face: FaceContext,
  declaration: TypeElement,
  byKey: Map<string, StaticMapEntry>,
  byHost: Map<SymbolId, StaticMapEntry>,
) {
  // TS7 declares PropertySignatureDeclaration.type non-optional; an unannotated member parses with none.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (!isPropertySignatureDeclaration(declaration) || declaration.type === undefined) {
    face.fail(declaration, 'TypertLookupMap entries must be required properties')
  }
  const key = memberName(declaration.name)
  if (!isRemoteSegment(key)) {
    face.fail(declaration.name, 'TypertLookupMap key must contain only RPC endpoint segment characters')
  }
  if (!isTypeReferenceNode(declaration.type)
    || !isTypeMetaSymbol(face, declaration.type.typeName, 'TypertLookup')
    || declaration.type.typeArguments?.length !== 2) {
    face.fail(declaration.type, 'TypertLookupMap values must be TypertLookup<Host, Wire>')
  }
  const hostNode = declaration.type.typeArguments[0]
  const wireNode = declaration.type.typeArguments[1]
  if (hostNode === undefined || wireNode === undefined) {
    face.fail(declaration.type, 'TypertLookupMap values must be TypertLookup<Host, Wire>')
  }
  const host = face.symbolAtType(hostNode)
  if (host === undefined) face.fail(hostNode, 'TypertLookup Host must be a named type')
  const entry: StaticMapEntry = { key, hostSymbol: face.symbolId(host), wireType: wireNode, site: declaration }
  if (byKey.has(key)) face.fail(declaration, `duplicate TypertLookupMap key ${key}`)
  if (entry.hostSymbol !== undefined && byHost.has(entry.hostSymbol)) {
    face.fail(declaration, `Host type ${host.name} has more than one Typert lookup`)
  }
  byKey.set(key, entry)
  if (entry.hostSymbol !== undefined) byHost.set(entry.hostSymbol, entry)
}

function addContext(face: FaceContext, declaration: TypeElement, result: Map<string, StaticMapEntry>) {
  // TS7 declares PropertySignatureDeclaration.type non-optional; an unannotated member parses with none.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (!isPropertySignatureDeclaration(declaration) || declaration.type === undefined) {
    face.fail(declaration, 'TypertContextMap entries must be required properties')
  }
  const key = memberName(declaration.name)
  if (!isRemoteSegment(key)) {
    face.fail(declaration.name, 'TypertContextMap key must contain only RPC endpoint segment characters')
  }
  if (!isTypeReferenceNode(declaration.type)
    || !isTypeMetaSymbol(face, declaration.type.typeName, 'TypertContext')
    || declaration.type.typeArguments?.length !== 1) {
    face.fail(declaration.type, 'TypertContextMap values must be TypertContext<Wire>')
  }
  if (result.has(key)) face.fail(declaration, `duplicate TypertContextMap key ${key}`)
  const contextNode = declaration.type.typeArguments[0]
  if (contextNode === undefined) face.fail(declaration.type, 'TypertContextMap values must be TypertContext<Wire>')
  result.set(key, { key, wireType: contextNode, site: declaration })
}

function protocolMembers(face: FaceContext, name: 'TypertLookupMap' | 'TypertContextMap'): TypeElement[] {
  const result: TypeElement[] = []
  for (const sourceFile of face.project.sourceFiles()) {
    for (const statement of sourceFile.statements) {
      if (!isModuleDeclaration(statement) || !isStringLiteral(statement.name)
        || statement.name.text !== '@deepseek-ai/dsh-typert-protocol'
        || statement.body === undefined || !isModuleBlock(statement.body)) continue
      for (const nested of statement.body.statements) {
        if (isInterfaceDeclaration(nested) && nested.name.text === name) result.push(...nested.members)
      }
    }
  }
  return result
}
