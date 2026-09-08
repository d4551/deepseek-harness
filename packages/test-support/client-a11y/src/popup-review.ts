import type { NodeResult, Result } from 'axe-core'

/** Native DOM evidence answering axe's controlsWithinPopup review. */
export interface CompletedPopupReview {
  readonly rule: 'aria-valid-attr-value'
  readonly node: NodeResult
  readonly controlledIds: readonly string[]
  readonly popupRole: string
  readonly expanded: boolean
}

function matchesReview(data: unknown, controls: string): boolean {
  return typeof data === 'object' && data !== null
    && 'messageKey' in data && data.messageKey === 'controlsWithinPopup'
    && 'needsReview' in data && data.needsReview === `aria-controls="${controls}"`
    && Object.keys(data).length === 2
}

function popupReview(node: NodeResult): CompletedPopupReview | undefined {
  const trigger = node.element
  if (!trigger?.isConnected) return
  const controls = trigger.getAttribute('aria-controls')
  const declaredRole = trigger.getAttribute('aria-haspopup')
  const expanded = trigger.getAttribute('aria-expanded')
  if (!controls || !declaredRole || !['true', 'false'].includes(expanded ?? '')) return
  const popupRole = declaredRole === 'true' ? 'menu' : declaredRole
  if (!['menu', 'listbox', 'tree', 'grid', 'dialog'].includes(popupRole)) return
  const checks = [...node.any, ...node.all, ...node.none]
  if (checks.length !== 1 || checks[0]?.id !== 'aria-valid-attr-value'
    || !matchesReview(checks[0].data, controls)) return
  const controlledIds = controls.trim().split(/\s+/)
  if (new Set(controlledIds).size !== controlledIds.length) return
  for (const id of controlledIds) {
    const matches = trigger.ownerDocument.querySelectorAll(`#${CSS.escape(id)}`)
    if (matches.length !== 1) return
    const popup = matches[0]
    if (!(popup instanceof HTMLElement) || popup.getAttribute('role') !== popupRole) return
    if (expanded === 'true' && (!popup.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      || popup.closest('[inert], [aria-hidden="true"]') !== null)) return
  }
  return { rule: 'aria-valid-attr-value', node, controlledIds, popupRole, expanded: expanded === 'true' }
}

/**
 * Complete only the exact popup-ID obligation against the audited DOM.
 * @param results - untouched incomplete results from the native browser audit.
 * @returns evidence for each popup reference fully verified in the DOM.
 */
export function completePopupReviews(results: readonly Result[]): readonly CompletedPopupReview[] {
  const completed: CompletedPopupReview[] = []
  for (const result of results) {
    if (result.id !== 'aria-valid-attr-value') continue
    for (const node of result.nodes) {
      const review = popupReview(node)
      if (review) completed.push(review)
    }
  }
  return completed
}
