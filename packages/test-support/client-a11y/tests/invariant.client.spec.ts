import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ClientA11yInvariant from '../src/invariant.ts'

describe('client-a11y invariant companion', () => {
  it('registers its explained empty runtime invariant under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(ClientA11yInvariant)

    expect(ClientA11yInvariant.name).toBe('client-a11y-invariant')
    expect(ClientA11yInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-client-a11y', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
