import axe from 'axe-core'
import { afterEach, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '../src/index.ts'
import { completePopupReviews } from '../src/popup-review.ts'

function popupSurface(id: string) {
  const root = document.createElement('div')
  const triggerRow = document.createElement('p')
  const trigger = document.createElement('button')
  trigger.id = `${id}-trigger`
  trigger.textContent = 'Choose action'
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'true')
  trigger.setAttribute('aria-controls', id)
  const popup = document.createElement('div')
  popup.id = id
  popup.setAttribute('role', 'menu')
  popup.setAttribute('aria-label', 'Actions')
  const item = document.createElement('button')
  item.textContent = 'Open'
  item.setAttribute('role', 'menuitem')
  popup.append(item)
  triggerRow.append(trigger)
  root.append(triggerRow, popup)
  return { root, trigger, popup }
}

afterEach(() => {
  document.body.replaceChildren()
})

it.each(['missing-controls', 'missing-haspopup', 'missing-expanded', 'not-popup', 'repeated-reference'])(
  'retains the native unresolved review for %s',
  async (state) => {
    const main = document.createElement('main')
    const { root, trigger } = popupSurface('actions')
    if (state === 'missing-controls') trigger.removeAttribute('aria-controls')
    if (state === 'missing-haspopup') trigger.removeAttribute('aria-haspopup')
    if (state === 'missing-expanded') trigger.removeAttribute('aria-expanded')
    if (state === 'not-popup') trigger.setAttribute('aria-haspopup', 'false')
    if (state === 'repeated-reference') trigger.setAttribute('aria-controls', 'actions actions')
    if (state === 'missing-controls' || state === 'missing-haspopup' || state === 'not-popup') {
      trigger.setAttribute('aria-current', 'later')
    }
    main.append(root)
    document.body.append(main)
    const audit = await auditSurface(state, main)
    expect(audit.violations).toEqual([])
    expect(audit.incomplete.map(result => result.id)).toEqual(['aria-valid-attr-value'])
    expect(audit.undecided).toBe(1)
    expect(audit.completedReviews).toEqual([])
    expect(accessibilityFailures([audit], 100)).toContain('aria-valid-attr-value at #actions-trigger')
  },
)

it('recognizes the native true value as a menu popup', async () => {
  const main = document.createElement('main')
  const { root, trigger } = popupSurface('actions')
  trigger.setAttribute('aria-haspopup', 'true')
  main.append(root)
  document.body.append(main)
  const audit = await auditSurface('menu-alias', main)
  expect(audit.undecided).toBe(1)
  expect(audit.completedReviews).toHaveLength(1)
  expect(audit.completedReviews[0]).toMatchObject({ popupRole: 'menu', controlledIds: ['actions'] })
  expect(accessibilityFailures([audit], 100)).toBe('')
})

it('refuses retained native review evidence after its trigger leaves the document', async () => {
  const main = document.createElement('main')
  const { root, trigger } = popupSurface('actions')
  main.append(root)
  document.body.append(main)
  const audit = await auditSurface('removed-trigger', main)
  expect(completePopupReviews(audit.incomplete)).toHaveLength(1)
  trigger.remove()
  expect(trigger.isConnected).toBe(false)
  expect(completePopupReviews(audit.incomplete)).toEqual([])
  expect(audit.incomplete).toHaveLength(1)
  expect(audit.undecided).toBe(1)
})

it('reports only unresolved nodes when one native popup review is complete', async () => {
  const main = document.createElement('main')
  const verified = popupSurface('verified-actions')
  const unresolved = popupSurface('unresolved-actions')
  unresolved.trigger.setAttribute('aria-controls', 'missing-actions')
  main.append(verified.root, unresolved.root)
  document.body.append(main)
  const audit = await auditSurface('mixed-popup-reviews', main)
  expect(audit.violations).toEqual([])
  expect(audit.undecided).toBe(2)
  expect(audit.incomplete).toHaveLength(1)
  expect(audit.incomplete[0]?.nodes).toHaveLength(2)
  expect(audit.completedReviews).toHaveLength(1)
  const report = accessibilityFailures([audit], 100)
  expect(report).toContain('aria-valid-attr-value at #unresolved-actions-trigger')
  expect(report).not.toContain('#verified-actions-trigger')
  expect(report).toContain('missing-actions')
})

it('reports native v2 rule help and restores v1 failure summaries after cleanup', async () => {
  const main = document.createElement('main')
  const { root, trigger } = popupSurface('actions')
  trigger.setAttribute('aria-controls', 'missing-actions')
  main.append(root)
  document.body.append(main)
  axe.configure({ reporter: 'v2' })
  try {
    const audit = await auditSurface('v2-unresolved', main)
    expect(audit.violations).toEqual([])
    expect(audit.undecided).toBe(1)
    expect(audit.completedReviews).toEqual([])
    const result = audit.incomplete[0]
    expect(result).toBeDefined()
    if (result === undefined) throw new Error('Native v2 audit must retain its unresolved rule')
    expect(result.nodes[0]?.failureSummary).toBeUndefined()
    expect(accessibilityFailures([audit], 100)).toBe(
      `v2-unresolved: unresolved checks (aria-valid-attr-value)\naria-valid-attr-value at #actions-trigger: ${result.help}`,
    )
  } finally {
    axe.configure({ reporter: 'v1' })
  }
  const restored = await auditSurface('v1-unresolved', main)
  expect(restored.incomplete[0]?.nodes[0]?.failureSummary).toContain('missing-actions')
  expect(accessibilityFailures([restored], 100)).toContain('missing-actions')
})
