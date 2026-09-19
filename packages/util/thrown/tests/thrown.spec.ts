import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Thrown } from '../src/index.ts'

describe('Thrown', () => {
  it('accepts every value a throw or Promise reject arm may deliver', () => {
    const values: Thrown[] = [
      { tag: 'thrown-object' },
      'thrown string',
      0,
      false,
      0n,
      Symbol('thrown-symbol'),
      null,
      undefined,
    ]
    expectTypeOf(values).toEqualTypeOf<Thrown[]>()
    expect(values).toHaveLength(8)
  })

  it('flows through a rejection handler without narrowing the runtime value', async () => {
    const reason: Thrown = 'thrown string'
    const seen: Thrown[] = []
    await Promise.reject(reason).catch((caught: Thrown) => {
      seen.push(caught)
    })
    expectTypeOf(seen).toEqualTypeOf<Thrown[]>()
    expect(seen).toEqual(['thrown string'])
  })
})
