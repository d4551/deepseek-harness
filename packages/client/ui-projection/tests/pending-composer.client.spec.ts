/**
 * The composer settlement adapter: a settle attempt reaches the caller
 * awaiting the answer, never the React handler that triggered it.
 */

import { describe, expect, it } from 'vitest'
import { settlePendingComposer } from '../src/pending-composer.ts'

describe('settlePendingComposer', () => {
  it('resolves once the one-shot settlement runs', async () => {
    let settled = 0

    await expect(settlePendingComposer(() => { settled += 1 }, 'unused')).resolves.toBeUndefined()
    expect(settled).toBe(1)
  })

  it('rejects with the thrown Error rather than throwing at the call site', async () => {
    const failure = new Error('already settled')

    await expect(settlePendingComposer(() => { throw failure }, 'unused')).rejects.toBe(failure)
  })

  it('wraps a non-Error throw in the caller-supplied message with its cause', async () => {
    const settlement = await settlePendingComposer(
      () => { throw 'resolve failed' },
      'pending question settlement failed',
    ).catch((error: unknown) => error)

    expect(settlement).toBeInstanceOf(Error)
    expect(settlement).toMatchObject({
      message: 'pending question settlement failed',
      cause: 'resolve failed',
    })
  })
})
