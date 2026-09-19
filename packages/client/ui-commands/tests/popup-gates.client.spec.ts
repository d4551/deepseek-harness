/**
 * The popupSelect shell's refusals and late settlements: a failure that is
 * not an Error still gets an error strip, a failure landing after dispose
 * writes nothing, and the risk-gate verbs are inert while no option waits
 * for acknowledgement. The main popup suite owns the happy paths.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SelectOption } from '../src/client/contract.ts'
import type { PopupSelectDeps, PopupSpec, TokenSegment } from '../src/client/popup.ts'
import { PopupSelectController } from '../src/client/popup.ts'

interface Ctx { readonly session: string }
const CTX: Ctx = { session: 'A' }
const SEGMENT: TokenSegment = { via: 'enter', token: '/theme' }
const OPTIONS: SelectOption[] = [{ id: 'dark', label: 'Dark' }]

function controller(): {
  popup: PopupSelectController<Ctx>
  consume: PopupSelectDeps['consume']
  focusComposer: PopupSelectDeps['focusComposer']
} {
  const consume = vi.fn<PopupSelectDeps['consume']>(() => true)
  const focusComposer = vi.fn<PopupSelectDeps['focusComposer']>()
  return { popup: new PopupSelectController<Ctx>({ consume, focusComposer }), consume, focusComposer }
}

function loading(options: PopupSpec<Ctx>['options']): PopupSpec<Ctx> {
  return { options, onSelect: () => undefined }
}

describe('failures that are not Errors', () => {
  it('surfaces a non-Error options rejection by its string form', async () => {
    const { popup } = controller()
    popup.open('theme', loading(async () => { throw 'directory said no' }), CTX, SEGMENT)
    await Promise.resolve()
    await Promise.resolve()
    expect(popup.state.getSnapshot()).toMatchObject({ open: true, status: 'failed', error: 'directory said no' })
  })
})

describe('late settlements', () => {
  it('a dispose racing a failing load drops the failure: no error strip on a closed shell', async () => {
    const { popup } = controller()
    const rejects: ((reason: Error) => void)[] = []
    popup.open('theme', loading(() => new Promise((_resolve, reject) => { rejects.push(reject) })), CTX, SEGMENT)
    popup.dispose()
    rejects[0]?.(new Error('directory down'))
    await Promise.resolve()
    expect(popup.state.getSnapshot()).toMatchObject({ open: false, status: 'pending', error: null })
  })
})

describe('the risk gate outside a confirmation', () => {
  it('acknowledge and cancelConfirmation are no-ops while no option waits for acknowledgement', async () => {
    const { popup } = controller()
    popup.open('theme', loading(() => Promise.resolve(OPTIONS)), CTX, SEGMENT)
    await Promise.resolve()
    const ready = popup.state.getSnapshot()
    expect(ready).toMatchObject({ status: 'ready', confirming: null })
    popup.acknowledge(true)
    popup.cancelConfirmation()
    expect(popup.state.getSnapshot()).toBe(ready)

    const { popup: closed } = controller()
    const initial = closed.state.getSnapshot()
    closed.acknowledge(true)
    closed.cancelConfirmation()
    expect(closed.state.getSnapshot()).toBe(initial)
    expect(initial).toMatchObject({ open: false, confirming: null, acknowledged: false })
  })
})
