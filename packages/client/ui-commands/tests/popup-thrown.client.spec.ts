import { describe, expect, it, vi } from 'vitest'
import type { SelectOption } from '../src/client/contract.ts'
import type { PopupSelectDeps, PopupSpec, TokenSegment } from '../src/client/popup.ts'
import { PopupSelectController } from '../src/client/popup.ts'

interface Ctx { readonly session: string }
const CTX: Ctx = { session: 'A' }
const SEGMENT: TokenSegment = { via: 'enter', token: '/theme' }
const OPTIONS: SelectOption[] = [{ id: 'dark', label: 'Dark' }]

function deps(): PopupSelectDeps {
  return {
    consume: vi.fn<PopupSelectDeps['consume']>(() => true),
    focusComposer: vi.fn<PopupSelectDeps['focusComposer']>(),
  }
}

describe('PopupSelectController Thrown claim', () => {
  it('surfaces a plain Thrown options refusal without an Error prefix', async () => {
    const popup = new PopupSelectController<Ctx>(deps())
    popup.open('theme', {
      options: () => Promise.reject('plain refusal'),
      onSelect: () => undefined,
    } satisfies PopupSpec<Ctx>, CTX, SEGMENT)
    await Promise.resolve()
    expect(popup.state.getSnapshot()).toMatchObject({
      open: true, status: 'failed', error: 'plain refusal',
    })
  })

  it('surfaces a plain Thrown onSelect refusal without an Error prefix', async () => {
    const popup = new PopupSelectController<Ctx>(deps())
    popup.open('theme', {
      options: () => Promise.resolve(OPTIONS),
      onSelect: () => Promise.reject('plain refusal'),
    } satisfies PopupSpec<Ctx>, CTX, SEGMENT)
    await Promise.resolve()
    await popup.select(0)
    expect(popup.state.getSnapshot()).toMatchObject({
      open: true, status: 'ready', submitting: false, error: 'plain refusal',
    })
  })
})
