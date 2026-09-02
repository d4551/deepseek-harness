// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderAgentDefaultModel } from './section-support.client.tsx'
import { candidate } from './section-support.client.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe('AgentDefaultModelCard', () => {
  it('offers the routes as one choice, so picking a second replaces the first', () => {
    const actions = renderAgentDefaultModel({
      catalogStatus: 'ready',
      candidates: [
        candidate('alpha', 'fast', { modelName: 'Fast', selected: true }),
        candidate('alpha', 'deep', { modelName: 'Deep' }),
        candidate('beta', 'fast', { modelName: 'Beta Fast' }),
      ],
    })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(new Set(radios.map(radio => radio.getAttribute('name'))).size).toBe(1)
    expect(screen.getByRole('radio', { name: /Fast/, checked: true })).toBeTruthy()
    expect(screen.getByText('alpha API', { exact: true })).toBeTruthy()
    expect(screen.getByText('beta API', { exact: true })).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: /Deep/ }))
    expect(actions.selectModel).toHaveBeenCalledWith('alpha\0deep')
  })

  it('lets the user reopen a failed directory request instead of stranding the card', () => {
    const actions = renderAgentDefaultModel({ catalogStatus: 'error' })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))

    expect(screen.getByText(en.agentDefaultModelLoadFailed)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.agentDefaultModelRetry }))

    expect(actions.retryCatalog).toHaveBeenCalledOnce()
  })

  it('reports directory progress, partial results, and an empty catalog', () => {
    renderAgentDefaultModel({ catalogStatus: 'loading' })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))
    expect(screen.getByText(en.agentDefaultModelLoading)).toBeTruthy()

    cleanup()
    renderAgentDefaultModel({
      catalogStatus: 'ready',
      catalogPartial: true,
      candidates: [candidate('legacy', 'old', { available: false, selected: true })],
    })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))
    expect(screen.getByText(en.agentDefaultModelPartial)).toBeTruthy()
    expect(screen.getByText(en.agentDefaultModelUnavailable)).toBeTruthy()
    expect(screen.getByText(en.agentDefaultModelUnavailableGroup)).toBeTruthy()

    cleanup()
    renderAgentDefaultModel({ catalogStatus: 'ready' })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))
    expect(screen.getByText(en.agentDefaultModelEmpty)).toBeTruthy()
  })

  it('writes the staged route on save and drops it on discard', () => {
    const actions = renderAgentDefaultModel({
      dirty: true,
      catalogStatus: 'ready',
      candidates: [candidate('alpha', 'fast', { modelName: 'Fast', selected: true })],
    })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('distinguishes a stale draft from a rejected save', () => {
    renderAgentDefaultModel({ dirty: true, conflicted: true })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))

    expect(screen.getByText(en.agentDefaultModelConflict)).toBeTruthy()
    expect(screen.queryByText(en.saveFailed)).toBeNull()
  })

  it('stays hidden when unavailable and offers no writable control while read-only', () => {
    renderAgentDefaultModel({ available: false })
    expect(screen.queryByText(en.agentDefaultModelTitle)).toBeNull()

    cleanup()
    renderAgentDefaultModel({
      writable: false,
      catalogStatus: 'ready',
      candidates: [candidate('alpha', 'fast', { modelName: 'Fast' })],
    })
    fireEvent.click(screen.getByText(en.agentDefaultModelTitle))

    expect(screen.getByRole('radio', { name: /Fast/ })).toHaveProperty('disabled', true)
  })
})
