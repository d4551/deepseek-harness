// @vitest-environment jsdom
/**
 * axe-core audit of the ui-deliverables browser surface: the produced-files
 * row rendered over a realistic overflowing match set and an open capability.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ProducedFiles } from '../src/client/ProducedFiles.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe('ui-deliverables accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100
  const capability = {
    isLoopback: true,
    ensureWorkspacePathOpen: () => {},
    useWorkspacePathOpen: <T,>(selector: (open: boolean | undefined) => T): T => selector(true),
  }

  it('renders no accessibility violations for the produced-files row', async () => {
    const audits: SurfaceAudit[] = []
    const overflowing = ['deep/a.html', 'b.css', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
    const { baseElement } = render(
      <main>
        <ProducedFiles matched={overflowing} openFile={() => {}} {...capability} t={makeTranslate(en)} />
      </main>,
    )
    audits.push(await auditSurface('ProducedFiles', baseElement))
    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
