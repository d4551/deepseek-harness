import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as CryptoInvariant from '../src/invariant.ts'

describe('crypto invariant companion', () => {
  it('registers its explained empty runtime invariant under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(CryptoInvariant)

    expect(CryptoInvariant.name).toBe('util-crypto-invariant')
    expect(CryptoInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-util-crypto', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases the package name when the companion is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(CryptoInvariant)
    await fiber.dispose()

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-util-crypto', () => {})
    }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
