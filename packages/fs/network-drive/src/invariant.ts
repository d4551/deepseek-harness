/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-network-drive`.
 * @module @deepseek-ai/dsh-network-drive/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-network-drive'

/** Cordis companion plugin name. */
export const name = 'network-drive-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package declares an abstract service and its
 * vocabulary, holding no mutable data and emitting no events. Each provider's
 * own companion checks the relations that provider maintains.
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
