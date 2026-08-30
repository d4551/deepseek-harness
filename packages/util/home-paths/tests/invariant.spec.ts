import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as HomePathsInvariant from '../src/invariant.ts'

describe('home-paths invariant companion', () => {
  it('registers its explained empty runtime invariant under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(HomePathsInvariant)

    expect(HomePathsInvariant.name).toBe('home-paths-invariant')
    expect(HomePathsInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-home-paths', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases the package name when the companion is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(HomePathsInvariant)
    await fiber.dispose()

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-home-paths', () => {})
    }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
