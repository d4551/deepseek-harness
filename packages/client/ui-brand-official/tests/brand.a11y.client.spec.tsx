// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  accessibilityFailures, auditSurface,
} from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'
import { OfficialBrandMark, OfficialBrandName } from '../src/client/Brand.tsx'

afterEach(cleanup)

describe('official brand accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for the official mark and name', async () => {
    const audits: SurfaceAudit[] = []
    const { baseElement: mark } = render(<main><OfficialBrandMark size={24} /></main>)
    audits.push(await auditSurface('OfficialBrandMark', mark))
    cleanup()
    const { baseElement: name } = render(<main><OfficialBrandName /></main>)
    audits.push(await auditSurface('OfficialBrandName', name))
    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
