/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-hosted-drive`.
 * @module @deepseek-ai/dsh-hosted-drive/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-hosted-drive'

/** Cordis companion plugin name. */
export const name = 'hosted-drive-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package carries only a static profile patch. The
 * drive provider and the drive-backed filesystem each check the relations they
 * maintain, and the one-workspace agreement between them is composition data
 * this layer writes rather than runtime state it can observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
