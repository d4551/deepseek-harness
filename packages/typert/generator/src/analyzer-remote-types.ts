/**
 * Remote gateway and static protocol-map entries for Typert extraction.
 */

import type { Node, TypeNode } from 'typescript/unstable/ast'
import type { SymbolId } from './model.ts'

/** One service bound into the Remote gateway, and where the binding was declared. */
export interface GatewayBinding {
  /** Bound service name. */
  readonly service: string
  /** RPC namespace the service answers on. */
  readonly namespace: string
  /** Node the binding was declared at; diagnostics locate here. */
  readonly site: Node
}

/** TypertLookupMap or TypertContextMap member. `hostSymbol` is set for lookups. */
export interface StaticMapEntry {
  readonly key: string
  readonly hostSymbol?: SymbolId
  readonly wireType: TypeNode
  readonly site: Node
}
