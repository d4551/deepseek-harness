/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-sqlite-connection`.
 * @module @deepseek-ai/dsh-sqlite-connection/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-sqlite-connection'

/** Cordis companion plugin name. */
export const name = 'sqlite-connection-invariant'
/** Service required before the companion can reserve the package name. */
export const inject = ['invariants']

// No runtime invariant: the settings this package owns live on a caller's
// SQLite connection, not in any event stream or mutable data this package
// keeps. Each setting is verified against that connection at open time, and
// the backend that owns the connection owns the relations stored through it.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
