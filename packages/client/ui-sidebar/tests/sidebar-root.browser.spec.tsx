import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SidebarRootComponentProps } from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

afterEach(cleanup)

function unexpectedHook(): never {
  throw new Error('Sidebar shell must not read domain state')
}

type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionPendingInteraction']>[0]>[0]
const attention: AttentionSnapshot = new Map()

it.each([false, true])('renders an accessible sidebar with collapsed=%s', async (collapsed) => {
  render(<main><SidebarRoot
    collapsed={collapsed}
    width={300}
    useSessions={unexpectedHook}
    useSessionPendingInteraction={select => select(attention)}
    useWorkspaces={unexpectedHook}
    startSession={vi.fn()}
    toggleSidebar={vi.fn()}
    t={makeTranslate(en, commonEn)}
    renderSlot={(key) => {
      if (key === 'sidebar.brand.mark') return <span>M</span>
      if (key === 'sidebar.brand.name') return <span>Custom Brand</span>
      return <div data-slot={key} />
    }}
  /></main>)
  const audit = await auditSurface(`SidebarRoot collapsed=${String(collapsed)}`, document.body)
  expect(audit.undecidedRules).toEqual([])
  expect(accessibilityFailures([audit], 100)).toBe('')
})
