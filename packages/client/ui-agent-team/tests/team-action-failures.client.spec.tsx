// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TeamAction, actions, props, remoteFailure, view } from './team-fixtures.client.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

it('replaces initial loading with the failed discovery result', async () => {
  render(<TeamAction {...props(actions({ load: () => Promise.reject(new Error('Discovery disconnected')) }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  expect((await screen.findByRole('alert')).textContent).toBe('Error: Discovery disconnected')
  expect(screen.queryByText(zh.loading)).toBeNull()
  expect(screen.getByRole('button', { name: zh.refresh })).toBeTruthy()
})

it('retains tracked work during a rejected refresh and recovers on retry', async () => {
  const load = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: view })
    .mockRejectedValueOnce(new Error('refresh disconnected'))
    .mockResolvedValueOnce({ ok: true, value: view })
  render(<TeamAction {...props(actions({ load }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText('Implement runtime')
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  expect((await screen.findByRole('alert')).textContent).toBe('Error: refresh disconnected')
  expect(screen.getByText('Implement runtime')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(load).toHaveBeenCalledTimes(3)
})

it('does not publish a navigation rejection into another conversation', async () => {
  const pending = Promise.withResolvers<undefined>()
  const rendered = render(<TeamAction {...props(actions({ openTeammate: () => pending.promise }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  fireEvent.click(await screen.findByRole('button', { name: 'worker' }))
  const next = view.members[1]
  if (next === undefined) throw new Error('Team fixture requires a second session')
  rendered.rerender(<TeamAction {...props(actions(), next.id)} />)
  pending.reject(new Error('previous navigation failed'))
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText('Implement runtime')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows a typed discovery failure without fabricating an empty board', async () => {
  render(<TeamAction {...props(actions({ load: () => Promise.resolve(remoteFailure('load failed')) }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  expect(await screen.findByText('load failed (internal)')).toBeTruthy()
  expect(screen.queryByText(zh.empty)).toBeNull()
})

it('contains navigation failures and keeps the panel dismissible', async () => {
  render(<TeamAction {...props(actions({ openTeammate: () => Promise.reject(new Error('navigation failed')) }))} />)
  const trigger = screen.getByRole('button', { name: /Agent Team/u })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('button', { name: 'worker' }))
  expect(await screen.findByText('Error: navigation failed')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
