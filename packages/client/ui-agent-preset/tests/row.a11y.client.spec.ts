// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentPresetRow } from '../src/client/AgentPresetRow.tsx'
import type { AgentPresetRowProps } from '../src/client/AgentPresetRow.tsx'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const ROW_READY: AgentPresetSettingsState = {
  status: 'ready',
  error: null,
  writable: true,
  currentValue: 'standard',
  options: [{ id: 'standard', trust: 'system', name: '标准模式' }],
}

describe('agent preset row accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for the default-preset control', async () => {
    const store = createSnapshotStore<AgentPresetSettingsState>(ROW_READY)
    const props: Pick<AgentPresetRowProps, 'load' | 'select' | 'useAgentPreset' | 't'> = {
      load: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => Promise.resolve()),
      useAgentPreset: bindSnapshotSelector(store),
      t: (key: string) => (en as Record<string, string>)[key] ?? key,
    }
    const { baseElement } = render(
      createElement('main', null, createElement(AgentPresetRow, props as AgentPresetRowProps)),
    )
    await waitFor(() => {
      expect(props.load).toHaveBeenCalled()
    })
    expect(accessibilityFailures(
      [await auditSurface('AgentPresetRow', baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })
})
