import type { Identifier } from 'typescript/unstable/ast'
import { isIdentifier } from 'typescript/unstable/ast/is'
import { API } from 'typescript/unstable/sync'

export function probe(node: Identifier | undefined): string {
  if (node !== undefined && isIdentifier(node)) return node.text
  return ''
}

export type ProbeApi = API
