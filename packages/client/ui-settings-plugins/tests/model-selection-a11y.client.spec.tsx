// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import {
  candidate,
  renderAgentDefaultModel,
  renderSubagentModelSelection,
} from './section-support.client.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe('model-selection card accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders the route list with no violations under either selection arity', async () => {
    renderAgentDefaultModel({
      catalogStatus: 'error',
      candidates: [
        candidate('alpha', 'fast', { modelName: 'Fast', selected: true }),
        candidate('legacy', 'old', { available: false }),
      ],
    })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))
    const single = await auditSurface('AgentDefaultModelCard', document.body)

    cleanup()
    renderSubagentModelSelection({
      enabled: true,
      catalogStatus: 'error',
      candidates: [candidate('alpha', 'fast', { modelName: 'Fast', selected: true })],
    })
    fireEvent.click(screen.getByText(en.subagentModelSelectionTitle))
    const multiple = await auditSurface('SubagentModelSelectionCard', document.body)

    expect(accessibilityFailures([single, multiple], MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
