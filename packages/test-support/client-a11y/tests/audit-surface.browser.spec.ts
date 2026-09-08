/**
 * Drives axe-core through auditSurface on a native browser tree. Score-only
 * helpers cannot substitute for this: an unnamed control must fail the floor.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface, formatViolations } from '../src/index.ts'

afterEach(() => {
  document.body.replaceChildren()
})

describe('auditSurface against axe-core', () => {
  it.each(['visible', 'missing-id', 'wrong-role', 'hidden-popup', 'duplicate-id', 'different-review'])('verifies popup references: %s', async (state) => {
    const main = document.createElement('main')
    const trigger = document.createElement('button')
    trigger.textContent = 'Choose action'
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'true')
    trigger.setAttribute('aria-controls', 'actions')
    if (state === 'different-review') trigger.setAttribute('aria-current', 'later')
    const popup = document.createElement('div')
    popup.id = state === 'missing-id' ? 'other-actions' : 'actions'
    popup.setAttribute('role', state === 'wrong-role' ? 'group' : 'menu')
    popup.setAttribute('aria-label', 'Actions')
    popup.hidden = state === 'hidden-popup'
    const item = document.createElement('button')
    item.textContent = 'Open'
    item.setAttribute('role', 'menuitem')
    popup.append(item)
    const triggerRow = document.createElement('p')
    triggerRow.append(trigger)
    main.append(triggerRow, popup)
    if (state === 'duplicate-id') main.append(popup.cloneNode(true))
    document.body.append(main)
    const audit = await auditSurface(`popup-${state}`, main)
    expect(audit.incomplete.some(result => result.id === 'aria-valid-attr-value')).toBe(true)
    if (state === 'visible') {
      expect(audit.completedReviews).toHaveLength(1)
      expect(audit.completedReviews[0]).toMatchObject({
        rule: 'aria-valid-attr-value', controlledIds: ['actions'], popupRole: 'menu', expanded: true,
      })
      expect(accessibilityFailures([audit], 100)).toBe('')
    } else {
      expect(audit.completedReviews).toEqual([])
      expect(accessibilityFailures([audit], 100)).not.toBe('')
    }
  })

  it('fails a control with no accessible name', async () => {
    const main = document.createElement('main')
    const control = document.createElement('button')
    main.append(control)
    document.body.append(main)
    const audit = await auditSurface('unnamed-control', main)
    expect(accessibilityFailures([audit], 100)).toMatch(/button-name/)
  })

  it('passes a named control in a landmark', async () => {
    const main = document.createElement('main')
    const control = document.createElement('button')
    control.textContent = '42'
    main.append(control)
    document.body.append(main)
    const audit = await auditSurface('named-control', main)
    expect(audit.passed + audit.failed).toBeGreaterThan(0)
    expect(formatViolations(audit)).toBe('')
    expect(accessibilityFailures([audit], 100)).toBe('')
  })
})
