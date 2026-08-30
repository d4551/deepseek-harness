import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as WorkspacePathInvariant from '../src/invariant.ts'

describe('workspace-path invariant companion', () => {
  it('registers its explained empty runtime invariant under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(WorkspacePathInvariant)

    expect(WorkspacePathInvariant.name).toBe('workspace-path-invariant')
    expect(WorkspacePathInvariant.inject).toEqual(['invariants'])
    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-util-workspace-path', () => {})
    }).toThrow(/already registered/)

    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases the package name when the companion is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(WorkspacePathInvariant)
    await fiber.dispose()

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-util-workspace-path', () => {})
    }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
