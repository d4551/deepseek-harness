// @vitest-environment jsdom
/**
 * Drives axe-core through auditSurface on a real jsdom tree. Score-only
 * helpers cannot substitute for this: an unnamed control must fail the floor.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface, formatViolations } from '../src/index.ts'

afterEach(() => {
  document.body.replaceChildren()
})

describe('auditSurface against axe-core', () => {
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
