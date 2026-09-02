/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-fs-network-drive`.
 * @module @deepseek-ai/dsh-fs-network-drive/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { drivePathOf } from './materialization.ts'
import { NetworkDriveFileSystem, isProviderVersion, targetKeyFor } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-fs-network-drive'

/** Cordis companion plugin name. */
export const name = 'fs-network-drive-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * Install the observation contract this provider depends on. The observation
 * policy replays a recorded `fs/observed` entry to authorize a later guarded
 * write, so an entry whose target or version this provider did not mint would
 * authorize that write against a file the drive never served. Each recorded
 * observation is checked back against this provider's own identity mapping
 * while it is the mounted `ctx.fs`.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('fs/observed', (target, observation) => {
    const fs = ctx.get('fs')
    if (!(fs instanceof NetworkDriveFileSystem)) return
    const workspacePath = drivePathOf(fs.materializationRoot, target.displayPath)
    if (workspacePath === undefined) {
      fail(`fs/observed recorded "${target.displayPath}", which is outside the materialization root ${fs.materializationRoot}`)
    }
    if (String(target.targetKey) !== targetKeyFor(workspacePath)) {
      fail(`fs/observed recorded "${target.displayPath}" under a target key this provider did not mint`)
    }
    if (observation.kind === 'present' && !isProviderVersion(observation.version)) {
      fail(`fs/observed recorded "${target.displayPath}" at a version this provider did not issue`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
