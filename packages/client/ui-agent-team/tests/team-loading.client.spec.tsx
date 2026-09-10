// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TeamView } from '@deepseek-ai/dsh-agent-team/client'
import { TeamAction, actions, props, task, view, remoteFailure, type TeamActionResult } from './team-fixtures.client.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

it('keeps messages and tracked tasks available while history is pending and cancels it on close', async () => {
  const history = Promise.withResolvers<TeamActionResult<TeamView['subagents']>>()
  const signals: AbortSignal[] = []
  render(<TeamAction {...props(actions({
    loadConversations: (_session, signal) => {
      signals.push(signal)
      return history.promise
    },
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText(task.subject)
  expect(screen.getByRole('log', { name: zh.messages })).toBeTruthy()
  expect(screen.getByText(zh.loadingConversations)).toBeTruthy()
  expect(screen.queryByText(zh.noSubagents)).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.close }))
  expect(signals).toHaveLength(1)
  expect(signals[0]?.aborted).toBe(true)
  await act(async () => { history.resolve(remoteFailure('History unavailable')) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows a history failure without hiding team work and retries history independently', async () => {
  let attempts = 0
  let overviewReads = 0
  render(<TeamAction {...props(actions({
    load: () => {
      overviewReads += 1
      return Promise.resolve({ ok: true, value: view })
    },
    loadConversations: () => {
      attempts += 1
      return Promise.resolve(attempts === 1 ? remoteFailure('History unavailable') : { ok: true, value: [] })
    },
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  expect((await screen.findByRole('alert')).textContent).toContain('History unavailable')
  expect(screen.getByText(task.subject)).toBeTruthy()
  const readsBeforeRetry = overviewReads
  fireEvent.click(screen.getByRole('button', { name: zh.refreshConversations }))
  await screen.findByText(zh.noSubagents)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(attempts).toBe(2)
  expect(overviewReads).toBe(readsBeforeRetry)
})

it('recovers a rejected overview request through the visible refresh action', async () => {
  let attempts = 0
  render(<TeamAction {...props(actions({
    load: () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('Team unavailable')) : Promise.resolve({ ok: true, value: view })
    },
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  expect((await screen.findByRole('alert')).textContent).toContain('Team unavailable')
  await waitFor(() => { expect(screen.queryByText(zh.loading)).toBeNull() })
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByText(task.subject)
  expect(screen.queryByRole('alert')).toBeNull()
})
