// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentLoopCard } from '../src/client/AgentLoopCard.tsx'
import type { AgentLoopCardProps } from '../src/client/AgentLoopCard.tsx'
import type { AgentLoopCardState } from '../src/client/agent-loop-card-controller.ts'
import { en } from '../src/client/locales.ts'
import { cardActions, field, settled, t } from './section-support.client.tsx'
import { cardProps } from './props.client.ts'

afterEach(cleanup)

function renderAgentLoop(state: Partial<AgentLoopCardState> = {}) {
  const store = createSnapshotStore<AgentLoopCardState>({
    ...settled,
    maxParallelToolCalls: field('10'),
    ...state,
  })
  const actions = cardActions()
  const props = cardProps<AgentLoopCardProps>({
    ...actions,
    t,
    useAgentLoopCard: bindSnapshotSelector(store),
  })
  render(<AgentLoopCard {...props} />)
  return actions
}

describe('AgentLoopCard', () => {
  it('stages and saves the only field it owns', () => {
    const actions = renderAgentLoop({ dirty: true, maxParallelToolCalls: field('10') })

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.change(screen.getByLabelText(en.agentLoopMaxParallel), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('maxParallelToolCalls', '2')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for the field it owns', () => {
    const actions = renderAgentLoop({ maxParallelToolCalls: field('2', { overridden: true }) })

    fireEvent.click(screen.getByText(en.agentLoopTitle))
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('maxParallelToolCalls')
  })
})
