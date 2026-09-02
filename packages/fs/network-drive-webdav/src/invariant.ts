/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-network-drive-webdav`.
 * @module @deepseek-ai/dsh-network-drive-webdav/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-network-drive-webdav'

/** Cordis companion plugin name. */
export const name = 'network-drive-webdav-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every operation returns the remote server's committed
 * answer directly. The provider keeps no cache, queue, or derived state that a
 * second observation could contradict.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
