/**
 * The one-execution-world check: the sandbox fence and the drive's
 * materialization root must name the same directory. The patch sets both from
 * one variable, but a profile patch or a `--patch` overlay may restate either
 * row alone, so the agreement is checked against the live values rather than
 * assumed from the composition that wrote them.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import NetworkDriveFileSystem from '@deepseek-ai/dsh-fs-network-drive'
import { NetworkDrive } from '@deepseek-ai/dsh-network-drive'
import type { DriveContent, DriveDirEntry, DrivePath, DriveStat, DriveVersion, DriveWriteIntent } from '@deepseek-ai/dsh-network-drive/types'
import type { FsObservation, FsTarget, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import * as HostedDriveInvariant from '../src/invariant.ts'

/** A drive that answers nothing: the check reads only roots, never the drive. */
class SilentDrive extends NetworkDrive {
  override stat(): Promise<DriveStat | undefined> { return Promise.resolve(undefined) }
  override list(): Promise<DriveDirEntry[]> { return Promise.resolve([]) }
  override read(): Promise<DriveContent> { return Promise.reject(new Error('unused')) }
  override write(_path: DrivePath, _bytes: Uint8Array, _intent: DriveWriteIntent): Promise<DriveVersion> {
    return Promise.reject(new Error('unused'))
  }
  override remove(): Promise<void> { return Promise.reject(new Error('unused')) }
  override move(): Promise<void> { return Promise.reject(new Error('unused')) }
  override makeDirectory(): Promise<void> { return Promise.reject(new Error('unused')) }
}

/** A target shape the observation event carries; the check reads neither field. */
const TARGET: FsTarget = { targetKey: 'drive:notes.md' as FsTargetKey, displayPath: 'notes.md' }
const OBSERVATION: FsObservation = { kind: 'absent' }

/**
 * Mount the drive-backed filesystem, optionally beside a sandbox policy.
 * @param fence - the directory the policy reports as its workspace root; defaults to the materialization root.
 * @param withPolicy - false leaves `sandboxPolicy` unmounted.
 * @returns the live context and the root the drive materializes into.
 */
async function mount(fence?: string, withPolicy = true): Promise<{ ctx: Context; root: string }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-one-world-')))
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  new SilentDrive(ctx)
  await ctx.plugin(NetworkDriveFileSystem, { materializationRoot: root })
  if (withPolicy) {
    ctx.provide('sandboxPolicy', {
      resolve: () => ({ mode: 'workspace-write' as const, workspaceRoot: fence ?? root }),
    } as never)
  }
  await ctx.plugin(HostedDriveInvariant).await()
  return { ctx, root }
}

describe('hosted-drive one-execution-world invariant', () => {
  it('passes when the fence and the materialization root name one directory', async () => {
    const { ctx } = await mount()
    expect(() => { ctx.emit('fs/observed', TARGET, OBSERVATION, undefined) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('fails when an overlay moves the fence away from the materialization root', async () => {
    // This is the split world the patch's comment warns about: every spawned
    // process still runs against the materialization root while confinement
    // names somewhere else.
    const { ctx } = await mount(join(tmpdir(), 'dsh-one-world-elsewhere'))
    expect(() => { ctx.emit('fs/observed', TARGET, OBSERVATION, undefined) })
      .toThrow('a command can write where the fence does not reach')
    await ctx.fiber.dispose()
  })

  it('stays silent when no sandbox policy is mounted', async () => {
    // A composition may serve the drive with no policy at all. This check owns
    // the agreement between two mounted rows, not the presence of one of them:
    // an unfenced tree is the sandbox layer's subject, not this layer's.
    const { ctx } = await mount(undefined, false)
    expect(() => { ctx.emit('fs/observed', TARGET, OBSERVATION, undefined) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('stays silent when the mounted filesystem is not the drive-backed one', async () => {
    // The layer's check owns one relation; another composition's provider is
    // not its to judge.
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    ctx.provide('sandboxPolicy', {
      resolve: () => ({ mode: 'workspace-write' as const, workspaceRoot: '/elsewhere' }),
    } as never)
    await ctx.plugin(HostedDriveInvariant).await()
    expect(() => { ctx.emit('fs/observed', TARGET, OBSERVATION, undefined) }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
