/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-hosted-drive`.
 * @module @deepseek-ai/dsh-hosted-drive/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { NetworkDriveFileSystem } from '@deepseek-ai/dsh-fs-network-drive'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox/roots'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

const PACKAGE_NAME = '@deepseek-ai/dsh-hosted-drive'

/** Cordis companion plugin name. */
export const name = 'hosted-drive-invariant'
/** Services required before reserving package ownership. */
export const inject = ['invariants']

/**
 * Install the one-execution-world check this layer's whole composition rests on.
 *
 * The patch sets the sandbox fence and the drive's materialization root from
 * one environment variable, but a profile's own `cordis.patch.yml` or a
 * `--patch` overlay may restate either row alone. When they diverge, every
 * spawned process still runs against the materialization root while the fence
 * names somewhere else, so a command writes where confinement does not reach
 * and the drive never sees it. Both values are live: the mounted provider
 * carries its root and the policy resolves its own, so the agreement is
 * observable rather than a composition-time hope.
 *
 * `fs/observed` is the check point because it fires whenever a read authorizes
 * a later guarded write — the exact path along which a split world does harm.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('fs/observed', () => {
    const fs = ctx.get('fs')
    if (!(fs instanceof NetworkDriveFileSystem)) return
    const policy = ctx.get('sandboxPolicy')
    if (policy === undefined) return
    // The same directory reaches the two rows under different spellings — a
    // symlinked temp root is `/var/…` to one and `/private/var/…` to the other
    // — so both are canonicalized the way the sandbox's own roots are.
    const fence = canonicalPath(policy.resolve().workspaceRoot)
    const materialized = canonicalPath(fs.materializationRoot)
    if (fence !== materialized) {
      fail(
        `the sandbox fences ${fence} while the drive materializes into ${materialized};`
        + ' a command can write where the fence does not reach, and the drive never sees it',
      )
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
