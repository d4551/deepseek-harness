/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-a11y`.
 * @module @deepseek-ai/dsh-client-a11y/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-a11y'

/** Cordis companion plugin name. */
export const name = 'client-a11y-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Package ownership registration. Browser test tasks and the execution reporter
 * enforce audit completion and scoring; they do not publish application events.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
