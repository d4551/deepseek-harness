/**
 * Two cards over one shared scope: what one card's save does to the other
 * card's projection and drafts when both bind the same namespace.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { BashCardController, type BashSettings } from '../src/client/bash-card-controller.ts'
import { acceptWrites, setOp } from './scope-stubs.client.ts'

describe('two Bash cards over one shared scope', () => {
  function pair(accepting: boolean) {
    const host = stubSettingsScope<BashSettings>()
    if (accepting) acceptWrites(host)
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 5_000, maxOutputBytes: 64_000 },
      user: { timeoutMs: 5_000 },
    })
    const first = new BashCardController(host.scope).inject()
    const second = new BashCardController(host.scope).inject()
    return { host, first, second }
  }

  it('revises the clean sibling when one card saves', async () => {
    const { host, first, second } = pair(true)

    first.edit('timeoutMs', '9000')
    first.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledWith([setOp('timeoutMs', 9_000)]) })

    expect(first.hooks.bashCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
    // The sibling never staged anything, so it shows the section as saved.
    expect(second.hooks.bashCard.getSnapshot()).toMatchObject({
      dirty: false,
      timeoutMs: { text: '9000', overridden: true },
    })
  })

  it('keeps the sibling draft that was staged before the other card saved', async () => {
    const { host, first, second } = pair(true)

    second.edit('timeoutMs', '7000')
    first.edit('timeoutMs', '9000')
    first.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledWith([setOp('timeoutMs', 9_000)]) })

    // The staged draft survives the sibling's save: only its own save or a
    // discard may drop it.
    expect(second.hooks.bashCard.getSnapshot()).toMatchObject({
      dirty: true,
      timeoutMs: { text: '7000', overridden: true },
    })
    second.discard()
    // Discarding re-seeds from the section, which now carries the saved value.
    expect(second.hooks.bashCard.getSnapshot()).toMatchObject({
      dirty: false,
      timeoutMs: { text: '9000' },
    })
  })

  it('leaves the sibling untouched when one card faces a rejecting Host', async () => {
    const { host, first, second } = pair(false)

    first.edit('timeoutMs', '9000')
    second.edit('maxOutputBytes', '1024')
    first.save()
    // Generous budget: the write's round trip resolves on a loaded fork pool.
    await vi.waitFor(() => { expect(first.hooks.bashCard.getSnapshot().failed).toBe(true) }, { timeout: 5_000 })

    // The write never landed, so the card keeps its draft for correction and
    // the sibling's independent draft is exactly as it staged it.
    expect(first.hooks.bashCard.getSnapshot()).toMatchObject({
      dirty: true,
      timeoutMs: { text: '9000' },
    })
    expect(second.hooks.bashCard.getSnapshot()).toMatchObject({
      dirty: true,
      maxOutputBytes: { text: '1024' },
    })
    expect(host.mutate).toHaveBeenCalledTimes(1)
  })

  it('delegates a read-only flip to the Host: no card hides the write it staged', async () => {
    const { host, first, second } = pair(false)

    first.edit('timeoutMs', '9000')
    second.edit('maxOutputBytes', '1024')
    host.publish({ status: 'ready', writable: false, value: { timeoutMs: 5_000 }, user: {} })

    // Read-only is a projection both cards show, not a gate the form enforces:
    // the write still leaves, and the rejecting Host keeps the draft staged.
    expect(first.hooks.bashCard.getSnapshot().writable).toBe(false)
    expect(second.hooks.bashCard.getSnapshot().writable).toBe(false)

    first.save()
    await vi.waitFor(() => { expect(first.hooks.bashCard.getSnapshot().failed).toBe(true) }, { timeout: 5_000 })

    expect(host.mutate).toHaveBeenCalledTimes(1)
    expect(first.hooks.bashCard.getSnapshot()).toMatchObject({
      dirty: true,
      timeoutMs: { text: '9000' },
    })
  })
})
