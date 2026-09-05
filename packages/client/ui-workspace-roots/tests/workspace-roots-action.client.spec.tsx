// @vitest-environment jsdom

/**
 * The workspace-root panel's mutations, failure handling, unmount behavior,
 * and the absolute-path validation. The rendered root set mirrors the host
 * projection; specs drive the projection.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isAbsolutePath, WorkspaceRootsAction } from '../src/client/WorkspaceRootsAction.tsx'
import { zh } from '../src/client/locales.ts'
import { PRIMARY, SECOND, SESSION, origin, projection, props, type RootsBench } from './roots-fixtures.client.ts'
import { openPanel, panelField, panelTriggerName } from './roots-bench.client.tsx'

afterEach(cleanup)

describe('WorkspaceRootsAction mutations', () => {
  it('adds a typed absolute folder to the recorded set', async () => {
    const { calls } = openPanel({ roots: projection() })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: ` ${SECOND} ` } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    await waitFor(() => { expect(calls.setRoots).toEqual([{ sessionId: SESSION, roots: [SECOND] }]) })
    await waitFor(() => { expect(panelField().value).toBe('') })
  })

  it('appends to the roots the Session already carries', async () => {
    const { calls } = openPanel({ roots: projection([SECOND]) })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: '/projects/third' } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    await waitFor(() => {
      expect(calls.setRoots).toEqual([{ sessionId: SESSION, roots: [SECOND, '/projects/third'] }])
    })
  })

  it('removes one root by sending the remaining set', async () => {
    const { calls } = openPanel({ roots: projection([SECOND, '/projects/third']) })
    fireEvent.click(screen.getByRole('button', { name: zh['remove.aria'].replace('{path}', SECOND) }))
    await waitFor(() => {
      expect(calls.setRoots).toEqual([{ sessionId: SESSION, roots: ['/projects/third'] }])
    })
  })

  it('refuses a relative path in the field rather than sending it', () => {
    const { calls } = openPanel({ roots: projection() })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: 'relative/dir' } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    const alert = screen.getByRole('alert')
    const field = screen.getByLabelText(zh['add.label'])
    expect(alert.textContent).toContain(zh['add.relative'])
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).toBe(alert.id)
    expect(calls.setRoots).toEqual([])
  })

  it('refuses a folder the Session already works in', () => {
    const { calls } = openPanel({ roots: projection([SECOND]) })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect(screen.getByRole('alert').textContent).toContain(zh['add.duplicate'])
    expect(calls.setRoots).toEqual([])
  })

  it('refuses the primary root as an addition', () => {
    const { calls } = openPanel({ roots: projection() })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: PRIMARY } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect(screen.getByRole('alert').textContent).toContain(zh['add.duplicate'])
    expect(calls.setRoots).toEqual([])
  })

  it('submits nothing for a blank field', () => {
    const { calls } = openPanel({ roots: projection() })
    const form = screen.getByLabelText(zh['add.label']).closest('form')
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: '   ' } })
    fireEvent.submit(form as HTMLFormElement)
    expect(calls.setRoots).toEqual([])
  })

  it('fills the field from the host directory chooser', async () => {
    const { calls } = openPanel({
      roots: projection(),
      pickDirectory: () => Promise.resolve('/chosen/folder'),
    })
    fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
    await waitFor(() => {
      expect(panelField().value).toBe('/chosen/folder')
    })
    expect(calls.picks).toBe(1)
  })

  it('leaves the field untouched when the chooser is cancelled', async () => {
    const { calls } = openPanel({ roots: projection() })
    fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
    await waitFor(() => { expect(calls.picks).toBe(1) })
    expect(panelField().value).toBe('')
  })

  it('reports a chooser this deployment cannot serve', async () => {
    openPanel({
      roots: projection(),
      pickDirectory: () => Promise.reject(new Error('directoryPicker.pick needs the native capability')),
    })
    fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
    expect((await screen.findByRole('alert')).textContent)
      .toContain('directoryPicker.pick needs the native capability')
    expect(screen.getByLabelText(zh['add.label']).hasAttribute('aria-invalid')).toBe(false)
  })
})

describe('WorkspaceRootsAction failures', () => {
  it('reports a refused replacement and retries the same set', async () => {
    let attempts = 0
    const { calls } = openPanel({
      roots: projection(),
      setRoots: (_sessionId, roots) => {
        attempts += 1
        return attempts === 1
          ? Promise.resolve({ ok: false, error: { code: 'session-not-found', message: 'gone', details: {} } })
          : Promise.resolve({ ok: true, value: { additional: [...roots] } })
      },
    })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('gone (session-not-found)')
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await waitFor(() => { expect(calls.setRoots).toHaveLength(2) })
    expect(calls.setRoots[1]).toEqual({ sessionId: SESSION, roots: [SECOND] })
  })

  it('reports a rejected replacement request and retries the same set', async () => {
    let attempts = 0
    const { calls } = openPanel({
      roots: projection(),
      setRoots: (_sessionId, roots) => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('socket closed'))
          : Promise.resolve({ ok: true, value: { additional: [...roots] } })
      },
    })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('socket closed')
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await waitFor(() => { expect(calls.setRoots).toHaveLength(2) })
    expect(calls.setRoots[1]).toEqual({ sessionId: SESSION, roots: [SECOND] })
  })

  it('reports a non-Error rejection by its stringified value', async () => {
    // The rejection reason is a bare string on purpose: the panel must
    // stringify whatever a handler rejects with, not just Error instances.
    const refusal = 'refused'
    openPanel({ roots: projection(), setRoots: async () => { throw refusal } })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('refused')
  })

  it('reports a non-Error chooser rejection by its stringified value', async () => {
    const cancellation = 'cancelled'
    openPanel({ roots: projection(), pickDirectory: async () => { throw cancellation } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('cancelled')
  })

  it('clears a validation message as soon as the field changes again', () => {
    openPanel({ roots: projection() })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: 'relative' } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: '/absolute' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the saving label and disables the controls while a replacement is in flight', async () => {
    let settle: (() => void) | undefined
    openPanel({
      roots: projection(),
      setRoots: (_sessionId, roots) => new Promise((resolve) => {
        settle = () => { resolve({ ok: true, value: { additional: [...roots] } }) }
      }),
    })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    const saving = await screen.findByRole('button', { name: zh.saving })
    expect(saving.hasAttribute('disabled')).toBe(true)
    expect(panelField().disabled).toBe(true)
    settle?.()
    await waitFor(() => { expect(screen.getByRole('button', { name: zh['add.submit'] })).toBeTruthy() })
  })
})

describe('WorkspaceRootsAction session changes', () => {
  const NEXT_SESSION = 'next-roots-session' as SessionId
  const NEXT_DRAFT = 'current-session-draft'

  it.each(['resolve', 'reject'] as const)(
    'drops a stale replacement that completes by %s',
    async (outcome) => {
      let settle!: () => void
      const pending = new Promise<{ ok: true; value: { additional: readonly string[] } }>((resolve, reject) => {
        settle = outcome === 'resolve'
          ? () => { resolve({ ok: true, value: { additional: [SECOND] } }) }
          : () => { reject(new Error('stale failure')) }
      })
      const built = props({ roots: projection(), setRoots: () => pending })
      const view = render(createElement(WorkspaceRootsAction, built.props))
      fireEvent.click(screen.getByRole('button', { name: panelTriggerName(1) }))
      fireEvent.change(panelField(), { target: { value: SECOND } })
      fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
      await waitFor(() => { expect(built.calls.setRoots).toHaveLength(1) })

      view.rerender(createElement(WorkspaceRootsAction, { ...built.props, sessionId: NEXT_SESSION }))
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      fireEvent.click(screen.getByRole('button', { name: panelTriggerName(1) }))
      fireEvent.change(panelField(), { target: { value: NEXT_DRAFT } })

      await act(async () => {
        settle()
        await Promise.resolve()
      })
      expect(panelField().value).toBe(NEXT_DRAFT)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByRole('button', { name: zh['add.submit'] })).toBeTruthy()
    },
  )

  it.each(['resolve', 'reject'] as const)(
    'drops a stale directory choice that completes by %s',
    async (outcome) => {
      let settle!: () => void
      const pending = new Promise<string | null>((resolve, reject) => {
        settle = outcome === 'resolve'
          ? () => { resolve('stale-choice') }
          : () => { reject(new Error('stale chooser failure')) }
      })
      const built = props({ roots: projection(), pickDirectory: () => pending })
      const view = render(createElement(WorkspaceRootsAction, built.props))
      fireEvent.click(screen.getByRole('button', { name: panelTriggerName(1) }))
      fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
      await waitFor(() => { expect(built.calls.picks).toBe(1) })

      view.rerender(createElement(WorkspaceRootsAction, { ...built.props, sessionId: NEXT_SESSION }))
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      fireEvent.click(screen.getByRole('button', { name: panelTriggerName(1) }))
      fireEvent.change(panelField(), { target: { value: NEXT_DRAFT } })

      await act(async () => {
        settle()
        await Promise.resolve()
      })
      expect(panelField().value).toBe(NEXT_DRAFT)
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )
})

describe('WorkspaceRootsAction after unmount', () => {
  /**
   * Settle one deferred injected call after the panel is gone. Every handler
   * that touches state is guarded, so a late answer must leave the document
   * empty instead of reviving a removed surface.
   * @param bench - the deferred action under test plus its projection.
   * @param settle - resolves or rejects the deferred call.
   * @param act - the interaction that starts the deferred call; the origin
   * read starts on mount, so only some scenarios need one.
   */
  async function settleAfterUnmount(
    bench: RootsBench,
    settle: () => void,
    act?: () => void,
  ): Promise<void> {
    openPanel(bench)
    act?.()
    cleanup()
    settle()
    await Promise.resolve()
    await Promise.resolve()
    expect(document.body.textContent).toBe('')
  }

  it('drops a replacement that resolves after the panel is gone', async () => {
    let settle: (() => void) | undefined
    await settleAfterUnmount(
      {
        roots: projection(),
        setRoots: (_sessionId, roots) => new Promise((resolve) => {
          settle = () => { resolve({ ok: true, value: { additional: [...roots] } }) }
        }),
      },
      () => { settle?.() },
      () => {
        fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
        fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
      },
    )
  })

  it('drops a replacement that rejects after the panel is gone', async () => {
    let fail: (() => void) | undefined
    await settleAfterUnmount(
      {
        roots: projection(),
        setRoots: () => new Promise((_resolve, reject) => {
          fail = () => { reject(new Error('late')) }
        }),
      },
      () => { fail?.() },
      () => {
        fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
        fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
      },
    )
  })

  it('drops a chosen directory that arrives after the panel is gone', async () => {
    let settle: (() => void) | undefined
    await settleAfterUnmount(
      {
        roots: projection(),
        pickDirectory: () => new Promise((resolve) => {
          settle = () => { resolve('/late') }
        }),
      },
      () => { settle?.() },
      () => { fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] })) },
    )
  })

  it('drops a chooser rejection that arrives after the panel is gone', async () => {
    let fail: (() => void) | undefined
    await settleAfterUnmount(
      {
        roots: projection(),
        pickDirectory: () => new Promise((_resolve, reject) => {
          fail = () => { reject(new Error('late')) }
        }),
      },
      () => { fail?.() },
      () => { fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] })) },
    )
  })

  it('drops an origin read that resolves after the panel is gone', async () => {
    let settle: (() => void) | undefined
    await settleAfterUnmount(
      {
        roots: projection(),
        loadOrigin: () => new Promise((resolve) => {
          settle = () => { resolve({ ok: true, value: origin('local') }) }
        }),
      },
      () => { settle?.() },
    )
  })

  it('drops an origin read that rejects after the panel is gone', async () => {
    let fail: (() => void) | undefined
    await settleAfterUnmount(
      {
        roots: projection(),
        loadOrigin: () => new Promise((_resolve, reject) => {
          fail = () => { reject(new Error('late')) }
        }),
      },
      () => { fail?.() },
    )
  })
})

describe('isAbsolutePath', () => {
  it('accepts the absolute spellings the host records and rejects the rest', () => {
    expect(isAbsolutePath('/projects/app')).toBe(true)
    expect(isAbsolutePath('C:/projects/app')).toBe(true)
    expect(isAbsolutePath('c:\\projects\\app')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isAbsolutePath('projects/app')).toBe(false)
    expect(isAbsolutePath('./projects')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })
})
