// @vitest-environment jsdom

/**
 * The workspace-root panel's states and origin read. The rendered root set
 * mirrors the host projection; specs drive the projection.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceRootsAction, originLabel } from '../src/client/WorkspaceRootsAction.tsx'
import { zh } from '../src/client/locales.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PRIMARY, SECOND, origin, projection, props } from './roots-fixtures.client.ts'
import { openPanel, panelTriggerName } from './roots-bench.client.tsx'

afterEach(cleanup)

describe('WorkspaceRootsAction states', () => {
  it('renders a busy placeholder while the projection has not arrived', () => {
    render(<WorkspaceRootsAction {...props({ roots: undefined }).props} />)
    expect(screen.getByRole('status', { name: zh['trigger.loading'] })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('counts the primary root and every additional root on the trigger', () => {
    render(<WorkspaceRootsAction {...props({ roots: projection([SECOND]) }).props} />)
    expect(screen.getByRole('button', { name: panelTriggerName(2) })).toBeTruthy()
  })

  it('counts only the additional roots when the Session has no cwd', () => {
    render(<WorkspaceRootsAction {...props({ roots: projection([SECOND], null) }).props} />)
    expect(screen.getByRole('button', { name: panelTriggerName(1) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: panelTriggerName(1) }))
    expect(screen.queryByText(zh.primary)).toBeNull()
    expect(screen.getByText(SECOND)).toBeTruthy()
  })

  it('shows the empty state while the Session works in its primary root alone', () => {
    openPanel({ roots: projection() })
    expect(screen.getByText(zh['empty.title'])).toBeTruthy()
    expect(screen.getByText(zh['empty.description'])).toBeTruthy()
    expect(screen.getByText(PRIMARY)).toBeTruthy()
  })

  it('drops the empty state once an additional root is recorded', () => {
    const { props: bench } = props({ roots: projection([SECOND]) })
    render(<WorkspaceRootsAction {...bench} />)
    fireEvent.click(screen.getByRole('button', { name: panelTriggerName(2) }))
    expect(screen.queryByText(zh['empty.title'])).toBeNull()
    expect(screen.getByRole('list', { name: zh['list.aria'] })).toBeTruthy()
  })

  it('closes the panel and returns focus to the trigger', () => {
    openPanel({ roots: projection() })
    const trigger = screen.getByRole('button', { name: panelTriggerName(1) })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const close = screen.getByRole('button', { name: zh.close })
    expect(document.activeElement).toBe(close)
    fireEvent.click(close)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on Escape and returns focus to the trigger', () => {
    openPanel({ roots: projection() })
    const trigger = screen.getByRole('button', { name: panelTriggerName(1) })
    fireEvent.keyDown(screen.getByRole('dialog', { name: zh.title }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})

describe('WorkspaceRootsAction origin', () => {
  it('names a local backend beside the primary root, reading it once', async () => {
    const { calls } = openPanel({ roots: projection() })
    expect(await screen.findByText(zh['origin.local'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    fireEvent.click(screen.getByRole('button', { name: panelTriggerName(1) }))
    await waitFor(() => { expect(screen.getByText(zh['origin.local'])).toBeTruthy() })
    expect(calls.origins).toBe(1)
  })

  it('names a network drive so a mirrored workspace does not read as local disk', async () => {
    openPanel({
      roots: projection(),
      loadOrigin: () => Promise.resolve({ ok: true, value: origin('network-drive') }),
    })
    expect(await screen.findByText(zh['origin.network-drive'])).toBeTruthy()
  })

  it('names an unrecognized origin member rather than claiming a known one', () => {
    const t = makeTranslate(zh) as never
    expect(originLabel('sandbox', t)).toBe(zh['origin.other'].replace('{kind}', 'sandbox'))
  })

  it('shows no origin when the deployment composes no filesystem backend', async () => {
    openPanel({ roots: projection(), loadOrigin: () => Promise.resolve({ ok: true, value: null }) })
    await waitFor(() => { expect(screen.queryByText(zh['origin.local'])).toBeNull() })
  })

  it('shows no origin when the origin read fails', async () => {
    openPanel({ roots: projection(), loadOrigin: () => Promise.reject(new Error('offline')) })
    await waitFor(() => { expect(screen.queryByText(zh['origin.local'])).toBeNull() })
  })

  it('shows no origin when the Remote refuses the read', async () => {
    openPanel({
      roots: projection(),
      loadOrigin: () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'no', details: {} } }),
    })
    await waitFor(() => { expect(screen.queryByText(zh['origin.local'])).toBeNull() })
  })
})
