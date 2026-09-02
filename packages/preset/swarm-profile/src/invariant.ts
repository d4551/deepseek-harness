/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-swarm-profile`.
 * @module @deepseek-ai/dsh-swarm-profile/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-swarm-profile'

/** Cordis companion plugin name. */
export const name = 'swarm-profile-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the package carries only a static profile patch. The
// subagent seam, the Team domain, and the Team tool package own the mutable
// relationships it activates.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
