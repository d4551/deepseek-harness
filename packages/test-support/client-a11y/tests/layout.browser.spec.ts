import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '../src/index.ts'
import './layout.browser.css'

afterEach(() => {
  document.body.replaceChildren()
})

describe('native accessibility layout', () => {
  it('rejects insufficient contrast with a decided rule result', async () => {
    const main = document.createElement('main')
    const text = document.createElement('p')
    text.className = 'insufficientContrast'
    text.textContent = 'This text must fail the contrast requirement.'
    main.append(text)
    document.body.append(main)
    expect(text.getBoundingClientRect().height).toBeGreaterThan(0)
    const audit = await auditSurface('insufficient contrast', main)
    expect(audit.undecidedRules).toEqual([])
    expect(accessibilityFailures([audit], 100)).toContain('color-contrast')
  })

  it('resolves generated pseudo-element content in a named control', async () => {
    const main = document.createElement('main')
    const control = document.createElement('button')
    control.className = 'generatedLabel'
    control.textContent = 'Action'
    main.append(control)
    document.body.append(main)
    expect(getComputedStyle(control, '::before').content).toBe('"Generated label"')
    const audit = await auditSurface('generated label', main)
    expect(audit.undecidedRules).toEqual([])
    expect(accessibilityFailures([audit], 100)).toBe('')
  })
})
