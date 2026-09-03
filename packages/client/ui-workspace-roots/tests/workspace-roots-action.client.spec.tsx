// @vitest-environment jsdom

/**
 * The workspace-root panel's four states and its two mutations. The rendered
 * root set is the host projection in every case, so a spec changes what the
 * panel shows by changing the projection, never by changing component state.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceRootsAction, isAbsolutePath, originLabel } from '../src/client/WorkspaceRootsAction.tsx'
import { zh } from '../src/client/locales.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PRIMARY, SECOND, SESSION, origin, projection, props } from './roots-fixtures.client.ts'

afterEach(cleanup)

/** The trigger's accessible name for a root set of `count` folders. */
function triggerName(count: number): string {
  return zh['trigger.aria'].replace('{count}', String(count))
}

/** The add-folder field, addressed by its own label. */
function field(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(zh['add.label'])
}

/** Render the panel already open over one bench. */
function open(bench: Parameters<typeof props>[0] = {}): ReturnType<typeof props> {
  const built = props(bench)
  const roots = bench.roots
  const count = roots === undefined
    ? 0
    : roots.additional.length + (roots.primary === null ? 0 : 1)
  render(<WorkspaceRootsAction {...built.props} />)
  fireEvent.click(screen.getByRole('button', { name: triggerName(count) }))
  return built
}

describe('WorkspaceRootsAction states', () => {
  it('renders a busy placeholder while the projection has not arrived', () => {
    render(<WorkspaceRootsAction {...props({ roots: undefined }).props} />)
    expect(screen.getByRole('status', { name: zh['trigger.loading'] })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('counts the primary root and every additional root on the trigger', () => {
    render(<WorkspaceRootsAction {...props({ roots: projection([SECOND]) }).props} />)
    expect(screen.getByRole('button', { name: triggerName(2) })).toBeTruthy()
  })

  it('counts only the additional roots when the Session has no cwd', () => {
    render(<WorkspaceRootsAction {...props({ roots: projection([SECOND], null) }).props} />)
    expect(screen.getByRole('button', { name: triggerName(1) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: triggerName(1) }))
    expect(screen.queryByText(zh.primary)).toBeNull()
    expect(screen.getByText(SECOND)).toBeTruthy()
  })

  it('shows the empty state while the Session works in its primary root alone', () => {
    open({ roots: projection() })
    expect(screen.getByText(zh['empty.title'])).toBeTruthy()
    expect(screen.getByText(zh['empty.description'])).toBeTruthy()
    expect(screen.getByText(PRIMARY)).toBeTruthy()
  })

  it('drops the empty state once an additional root is recorded', () => {
    const { props: bench } = props({ roots: projection([SECOND]) })
    render(<WorkspaceRootsAction {...bench} />)
    fireEvent.click(screen.getByRole('button', { name: triggerName(2) }))
    expect(screen.queryByText(zh['empty.title'])).toBeNull()
    expect(screen.getByRole('list', { name: zh['list.aria'] })).toBeTruthy()
  })

  it('closes the panel and returns focus to the trigger', () => {
    open({ roots: projection() })
    const trigger = screen.getByRole('button', { name: triggerName(1) })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('WorkspaceRootsAction origin', () => {
  it('names a local backend beside the primary root, reading it once', async () => {
    const { calls } = open({ roots: projection() })
    expect(await screen.findByText(zh['origin.local'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    fireEvent.click(screen.getByRole('button', { name: triggerName(1) }))
    await waitFor(() => { expect(screen.getByText(zh['origin.local'])).toBeTruthy() })
    expect(calls.origins).toBe(1)
  })

  it('names a network drive so a mirrored workspace does not read as local disk', async () => {
    open({
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
    open({ roots: projection(), loadOrigin: () => Promise.resolve({ ok: true, value: null }) })
    await waitFor(() => { expect(screen.queryByText(zh['origin.local'])).toBeNull() })
  })

  it('shows no origin when the origin read fails', async () => {
    open({ roots: projection(), loadOrigin: () => Promise.reject(new Error('offline')) })
    await waitFor(() => { expect(screen.queryByText(zh['origin.local'])).toBeNull() })
  })

  it('shows no origin when the Remote refuses the read', async () => {
    open({
      roots: projection(),
      loadOrigin: () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'no', details: {} } }),
    })
    await waitFor(() => { expect(screen.queryByText(zh['origin.local'])).toBeNull() })
  })
})

describe('WorkspaceRootsAction mutations', () => {
  it('adds a typed absolute folder to the recorded set', async () => {
    const { calls } = open({ roots: projection() })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: ` ${SECOND} ` } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    await waitFor(() => { expect(calls.setRoots).toEqual([{ sessionId: SESSION, roots: [SECOND] }]) })
    await waitFor(() => { expect(field().value).toBe('') })
  })

  it('appends to the roots the Session already carries', async () => {
    const { calls } = open({ roots: projection([SECOND]) })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: '/projects/third' } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    await waitFor(() => {
      expect(calls.setRoots).toEqual([{ sessionId: SESSION, roots: [SECOND, '/projects/third'] }])
    })
  })

  it('removes one root by sending the remaining set', async () => {
    const { calls } = open({ roots: projection([SECOND, '/projects/third']) })
    fireEvent.click(screen.getByRole('button', { name: zh['remove.aria'].replace('{path}', SECOND) }))
    await waitFor(() => {
      expect(calls.setRoots).toEqual([{ sessionId: SESSION, roots: ['/projects/third'] }])
    })
  })

  it('refuses a relative path in the field rather than sending it', () => {
    const { calls } = open({ roots: projection() })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: 'relative/dir' } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect(screen.getByRole('alert').textContent).toContain(zh['add.relative'])
    expect(calls.setRoots).toEqual([])
  })

  it('refuses a folder the Session already works in', () => {
    const { calls } = open({ roots: projection([SECOND]) })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect(screen.getByRole('alert').textContent).toContain(zh['add.duplicate'])
    expect(calls.setRoots).toEqual([])
  })

  it('refuses the primary root as an addition', () => {
    const { calls } = open({ roots: projection() })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: PRIMARY } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect(screen.getByRole('alert').textContent).toContain(zh['add.duplicate'])
    expect(calls.setRoots).toEqual([])
  })

  it('submits nothing for a blank field', () => {
    const { calls } = open({ roots: projection() })
    const form = screen.getByLabelText(zh['add.label']).closest('form')
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: '   ' } })
    fireEvent.submit(form as HTMLFormElement)
    expect(calls.setRoots).toEqual([])
  })

  it('fills the field from the host directory chooser', async () => {
    const { calls } = open({
      roots: projection(),
      pickDirectory: () => Promise.resolve('/chosen/folder'),
    })
    fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
    await waitFor(() => {
      expect(field().value).toBe('/chosen/folder')
    })
    expect(calls.picks).toBe(1)
  })

  it('leaves the field untouched when the chooser is cancelled', async () => {
    const { calls } = open({ roots: projection() })
    fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
    await waitFor(() => { expect(calls.picks).toBe(1) })
    expect(field().value).toBe('')
  })

  it('reports a chooser this deployment cannot serve', async () => {
    open({
      roots: projection(),
      pickDirectory: () => Promise.reject(new Error('directoryPicker.pick needs the native capability')),
    })
    fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
    expect((await screen.findByRole('alert')).textContent)
      .toContain('directoryPicker.pick needs the native capability')
  })
})

describe('WorkspaceRootsAction failures', () => {
  it('reports a refused replacement and retries the same set', async () => {
    let attempts = 0
    const { calls } = open({
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
    const { calls } = open({
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
    open({ roots: projection(), setRoots: () => Promise.reject('refused') })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('refused')
  })

  it('reports a non-Error chooser rejection by its stringified value', async () => {
    open({ roots: projection(), pickDirectory: () => Promise.reject('cancelled') })
    fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] }))
    expect((await screen.findByRole('alert')).textContent).toContain('cancelled')
  })

  it('clears a validation message as soon as the field changes again', () => {
    open({ roots: projection() })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: 'relative' } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: '/absolute' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the saving label and disables the controls while a replacement is in flight', async () => {
    let settle: (() => void) | undefined
    open({
      roots: projection(),
      setRoots: (_sessionId, roots) => new Promise((resolve) => {
        settle = () => { resolve({ ok: true, value: { additional: [...roots] } }) }
      }),
    })
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    const saving = await screen.findByRole('button', { name: zh.saving })
    expect(saving.hasAttribute('disabled')).toBe(true)
    expect(field().disabled).toBe(true)
    settle?.()
    await waitFor(() => { expect(screen.getByRole('button', { name: zh['add.submit'] })).toBeTruthy() })
  })
})

describe('WorkspaceRootsAction after unmount', () => {
  /**
   * Settle one deferred injected call after the panel is gone. Every handler
   * that touches state is guarded, so a late answer must leave the document
   * empty instead of reviving a removed surface.
   * @param bench - the deferred action under test plus its projection.
   * @param act - the interaction that starts the deferred call.
   * @param settle - resolves or rejects the deferred call.
   */
  async function settleAfterUnmount(
    bench: Parameters<typeof props>[0],
    act: () => void,
    settle: () => void,
  ): Promise<void> {
    open(bench)
    act()
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
      () => {
        fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
        fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
      },
      () => { settle?.() },
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
      () => {
        fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: SECOND } })
        fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
      },
      () => { fail?.() },
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
      () => { fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] })) },
      () => { settle?.() },
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
      () => { fireEvent.click(screen.getByRole('button', { name: zh['add.browse'] })) },
      () => { fail?.() },
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
      () => {},
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
      () => {},
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
