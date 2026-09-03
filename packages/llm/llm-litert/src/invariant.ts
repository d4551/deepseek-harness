/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-litert`.
 * @module @deepseek-ai/dsh-llm-litert/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-litert'

/** Cordis companion plugin name. */
export const name = 'llm-litert-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no session event and owns no mutable
 * data beyond one process handle; the durable request relations belong to the LLM
 * seam and the pi-ai adapter this route delegates to.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
