/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-keyed-lock`.
 * @module @deepseek-ai/dsh-keyed-lock/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-keyed-lock'

/** Cordis companion plugin name. */
export const name = 'keyed-lock-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this pure primitive owns no event stream, and its only
 * mutable data is the per-key queue map, which is internal and empties itself.
 * Serialization order and the drained-key cleanup are proven by unit tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
