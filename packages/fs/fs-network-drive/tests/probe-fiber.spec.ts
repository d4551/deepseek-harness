/**
 * Plugin-fiber rejection semantics across runtimes: a plugin constructor that
 * throws must surface as a rejected promise however the caller adopts the
 * returned Fiber — direct adoption via `Promise.resolve` and the explicit
 * `fiber.await()` entry point. Vitest unwraps the Fiber thenable implicitly;
 * `bun test` does not, so both adoption shapes are pinned here.
 */

import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import NetworkDriveFileSystem from '../src/index.ts'
import { FakeDrive } from './harness.ts'

describe('NetworkDriveFileSystem plugin fiber rejection', () => {
  it('rejects an invalid configuration through promise adoption of the fiber', async () => {
    const ctx = new Context()
    new FakeDrive(ctx)
    await expect(Promise.resolve(ctx.plugin(NetworkDriveFileSystem, { materializationRoot: tmpdir(), maxFileBytes: -1 })))
      .rejects.toThrow('maxFileBytes must be a positive integer')
    await ctx.fiber.dispose()
  })

  it('rejects an invalid configuration through fiber.await()', async () => {
    const ctx = new Context()
    new FakeDrive(ctx)
    await expect(ctx.plugin(NetworkDriveFileSystem, { materializationRoot: 'relative' }).await())
      .rejects.toThrow('materializationRoot must be an absolute path')
    await ctx.fiber.dispose()
  })
})
