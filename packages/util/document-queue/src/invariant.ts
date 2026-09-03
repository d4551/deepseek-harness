/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-document-queue`.
 * @module @deepseek-ai/dsh-document-queue/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-document-queue'

/** Cordis companion plugin name. */
export const name = 'document-queue-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each queue instance is private to the provider that constructed it, so
 * this package owns no event stream and no shared mutable data. The chain's ordering, drain, and
 * refusal-after-close rules are relations between one caller's own operations, which its unit
 * tests and each owning provider's disposal tests exercise directly.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
