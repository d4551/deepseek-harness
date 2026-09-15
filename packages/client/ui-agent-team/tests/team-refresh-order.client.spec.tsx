// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TeamAction, actions, props, view, type TeamActionResult } from './team-fixtures.client.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

it('continues observing activity after a rejected overview read', async () => {
  const changed = Promise.withResolvers<undefined>()
  let reads = 0
  render(<TeamAction {...props(actions({
    changes: async function* (sessionId, signal) {
      yield 0
      await changed.promise
      yield* actions().changes(sessionId, signal)
    },
    load: () => {
      reads += 1
      return reads === 1
        ? Promise.reject(new Error('overview unavailable'))
        : Promise.resolve({ ok: true, value: view })
    },
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  expect((await screen.findByRole('alert')).textContent).toContain('overview unavailable')
  await act(async () => { changed.resolve(undefined) })
  await screen.findByText('Implement runtime')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reads).toBe(2)
})

it('keeps the newest successful overview when an older manual refresh rejects', async () => {
  const older = Promise.withResolvers<TeamActionResult<typeof view>>()
  let reads = 0
  render(<TeamAction {...props(actions({
    load: () => {
      reads += 1
      return reads === 2 ? older.promise : Promise.resolve({ ok: true, value: view })
    },
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText('Implement runtime')
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.refresh })) })
  expect(reads).toBe(3)
  await act(async () => { older.reject(new Error('outdated refresh failed')) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('Implement runtime')).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('false')
})

it('keeps the current refresh pending when an older request rejects', async () => {
  const older = Promise.withResolvers<TeamActionResult<typeof view>>()
  const latest = Promise.withResolvers<TeamActionResult<typeof view>>()
  let reads = 0
  render(<TeamAction {...props(actions({
    load: () => {
      reads += 1
      if (reads === 2) return older.promise
      if (reads === 3) return latest.promise
      return Promise.resolve({ ok: true, value: view })
    },
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText('Implement runtime')
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await act(async () => { older.reject(new Error('outdated refresh failed')) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('true')
  await act(async () => { latest.resolve({ ok: true, value: view }) })
  expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('false')
})
