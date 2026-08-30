import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as NativeCommandInvariant from '../src/invariant.ts'

describe('native-command invariant companion', () => {
  it('registers its explained empty runtime invariant under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(NativeCommandInvariant)

    expect(NativeCommandInvariant.name).toBe('native-command-invariant')
    expect(NativeCommandInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-native-command', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases the package name when the companion is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(NativeCommandInvariant)
    await fiber.dispose()

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-native-command', () => {})
    }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
