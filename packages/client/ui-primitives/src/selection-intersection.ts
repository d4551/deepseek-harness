/**
 * Clipboard-copy activation must not steal an in-progress text selection
 * that intersects the copyable surface. Callers pass the live Selection or a
 * range-count probe with the same intersection contract.
 */
export interface SelectionIntersection {
  readonly isCollapsed: boolean
  readonly rangeCount: number
  getRangeAt: (index: number) => Pick<Range, 'intersectsNode'>
}

/**
 * Whether any live range intersects `node`.
 * @param selection - the document selection, or a range-count probe.
 * @param node - the copyable surface.
 * @returns true when a non-collapsed intersecting range exists.
 */
export function selectionIntersectsNode(
  selection: SelectionIntersection | null,
  node: Node,
): boolean {
  if (selection === null || selection.isCollapsed) return false
  for (let i = 0; i < selection.rangeCount; i += 1) {
    if (selection.getRangeAt(i).intersectsNode(node)) return true
  }
  return false
}
