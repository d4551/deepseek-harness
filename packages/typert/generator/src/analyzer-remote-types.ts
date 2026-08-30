/**
 * Remote gateway and static protocol-map entries for Typert extraction.
 */

import type { Node, TypeNode } from 'typescript/unstable/ast'
import type { SymbolId } from './model.ts'

export interface GatewayBinding {
  readonly service: string
  readonly namespace: string
  readonly site: Node
}

/** TypertLookupMap or TypertContextMap member. `hostSymbol` is set for lookups. */
export interface StaticMapEntry {
  readonly key: string
  readonly hostSymbol?: SymbolId
  readonly wireType: TypeNode
  readonly site: Node
}
