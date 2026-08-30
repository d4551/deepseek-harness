// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { renderSessionArea } from '../src/client/session-provider.tsx'

afterEach(cleanup)

function binding(key: string | undefined): StandardSourceBinding {
  return { key, hooks: {}, keyedHooks: {}, props: {} }
}

describe('session area accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for a selected session body', async () => {
    const { baseElement } = render(
      <main>{renderSessionArea(binding('s1'), { children: <p>Session body</p> })}</main>,
    )
    expect(accessibilityFailures(
      [await auditSurface('session body', baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })
})
