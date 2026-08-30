import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as BrandInvariant from '../src/invariant.ts'

describe('brand invariant companion', () => {
  it('registers its explained empty runtime invariant under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(BrandInvariant)

    expect(BrandInvariant.name).toBe('brand-invariant')
    expect(BrandInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-brand', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases the package name when the companion is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(BrandInvariant)
    await fiber.dispose()

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-brand', () => {})
    }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
