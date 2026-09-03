/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-projection`.
 * @module @deepseek-ai/dsh-client-ui-projection/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-projection'

/** Cordis companion plugin name. */
export const name = 'client-ui-projection-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every export is a pure fold over values its caller
 * already holds — no Cordis API, no events, no service, and no module state to
 * relate. The folds themselves are asserted directly by this package's specs.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
