// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ProducedFiles } from '../src/client/ProducedFiles.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('produced files accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for an openable file chip', async () => {
    const { baseElement } = render(
      <main>
        <ProducedFiles
          matched={['notes/a.md']}
          openFile={() => {}}
          isLoopback
          ensureWorkspacePathOpen={() => {}}
          useWorkspacePathOpen={selector => selector(true)}
          t={makeTranslate(zh)}
        />
      </main>,
    )
    expect(accessibilityFailures(
      [await auditSurface('ProducedFiles', baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })
})
