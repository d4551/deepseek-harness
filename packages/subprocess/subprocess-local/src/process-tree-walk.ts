/**
 * The children-first process-table walk both platform inspectors run. The POSIX
 * tables carry each row's start identity, while the Windows table carries only
 * pid/parent pairs and resolves identity per member, so the walk takes the
 * identity step from its caller.
 * @module dsh-subprocess-local/process-tree-walk
 */

import type { ProcessIdentity } from './process-inspector.ts'

/** The parent link every platform's process-table row exposes. */
export interface ProcessTreeRow {
  pid: number
  parentPid: number
}

/**
 * Walk a process table from one root, emitting children before parents. A row
 * whose identity is unreadable is dropped from the result: the table listed it,
 * but nothing can fence a signal to it. A cycle in the parent links visits each
 * row once.
 * @param entries - the process-table snapshot to walk.
 * @param rootPid - the tree root to descend from.
 * @param identify - start identity for one member, or undefined when unreadable.
 * @returns the root and its transitive descendants, children first; empty when the table omits the root.
 */
export function walkProcessTree<Row extends ProcessTreeRow>(
  entries: readonly Row[],
  rootPid: number,
  identify: (entry: Row) => ProcessIdentity | undefined,
): ProcessIdentity[] {
  const byPid = new Map(entries.map(entry => [entry.pid, entry]))
  const root = byPid.get(rootPid)
  if (root === undefined) return []
  const byParent = new Map<number, Row[]>()
  for (const entry of entries) {
    const children = byParent.get(entry.parentPid) ?? []
    children.push(entry)
    byParent.set(entry.parentPid, children)
  }
  const visited = new Set<number>()
  const result: ProcessIdentity[] = []
  const visit = (entry: Row): void => {
    if (visited.has(entry.pid)) return
    visited.add(entry.pid)
    for (const child of byParent.get(entry.pid) ?? []) visit(child)
    const identity = identify(entry)
    if (identity !== undefined) result.push(identity)
  }
  visit(root)
  return result
}
