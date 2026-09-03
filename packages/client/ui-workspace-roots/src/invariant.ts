/** Package-owned invariant companion for the workspace-root panel. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workspace-roots'

/** Cordis companion plugin name. */
export const name = 'client-ui-workspace-roots-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: the host projection is authoritative and this package owns one disposable slot registration. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant ownership.
 * @param ctx - Cordis Context carrying the invariant registry.
 * @returns disposer for the package registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
