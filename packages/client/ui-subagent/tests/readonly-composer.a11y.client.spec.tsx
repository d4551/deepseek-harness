// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SubagentReadOnlyComposer } from '../src/client/SubagentReadOnlyComposer.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

describe('read-only composer accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for either read-only reason', async () => {
    const audits = []
    const oneShot = render(
      <main><SubagentReadOnlyComposer matched={{ reason: 'one-shot' }} t={t} /></main>,
    )
    audits.push(await auditSurface('SubagentReadOnlyComposer one-shot', oneShot.baseElement))
    cleanup()
    const parent = render(
      <main><SubagentReadOnlyComposer matched={{ reason: 'parent-unavailable' }} t={t} /></main>,
    )
    audits.push(await auditSurface('SubagentReadOnlyComposer parent-unavailable', parent.baseElement))
    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
