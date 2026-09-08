import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionNodeItem } from '../src/client/rows/Rows.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

it.each([
  { surface: 'SessionNodeItem idle', running: false, selected: false },
  { surface: 'SessionNodeItem running', running: true, selected: false },
  { surface: 'SessionNodeItem multi-selected', running: false, selected: true },
])('renders accessible $surface', async ({ surface, running, selected }) => {
  const selection = {
    active: true, count: 2, archivableCount: 2,
    extend: vi.fn(), toggle: vi.fn(), selectAll: vi.fn(), anchor: vi.fn(), archiveSelected: vi.fn(),
  }
  const { baseElement } = render(<main>
    <div role="tree" aria-label="Sessions" aria-multiselectable="true">
      <SessionNodeItem
        seat={{ rowKey: 'session:row', seated: true, level: 1, move: vi.fn(), typeAhead: vi.fn() }}
        node={{
          id: SessionId('a11y'), title: 'Audited Session', blank: false, running,
          runningSubagentCount: 0, completed: false, updatedAt: 0,
        }}
        currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()}
        {...selected ? { selection } : {}}
        flat t={makeTranslate(zh, commonZh)}
      />
    </div>
  </main>)
  const audit = await auditSurface(surface, baseElement)
  expect(audit.passed + audit.failed).toBeGreaterThan(0)
  expect(audit.undecidedRules).toEqual([])
  expect(accessibilityFailures([audit], 100)).toBe('')
})
