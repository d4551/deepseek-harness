// @vitest-environment jsdom
/** Classifier probe: a minimal axe audit of a plain surface. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'

afterEach(cleanup)

describe('probe', () => {
  it('audits a plain surface', async () => {
    const audits: SurfaceAudit[] = []
    const { baseElement } = render(<main><p>Probe</p></main>)
    audits.push(await auditSurface('Probe', baseElement))
    expect(accessibilityFailures(audits, 100)).toBe('')
  })
})
