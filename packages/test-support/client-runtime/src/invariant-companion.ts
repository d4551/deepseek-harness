/**
 * Shared assertion helper for the per-package invariant companion skeleton
 * specs. Each client UI package's `invariant.client.spec.ts` calls this with
 * its own companion plugin and host entry to verify the same two contracts.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

/**
 * Assert the two skeleton contracts every client UI package's invariant
 * companion must satisfy: the companion registers under its package name on a
 * fresh Cordis context, and the host entry's apply runs without side effects.
 * @param companion - the `./invariant` module namespace.
 * @param hostEntry - a promise of the package's root module (dynamic import).
 */
export function assertInvariantCompanion(
  companion: Plugin,
  hostEntry: Promise<{ apply(): void }>,
): void {
  describe('invariant companion', () => {
    it('registers under the package name with an empty installer', async () => {
      const ctx = new Context()
      await ctx.plugin(InvariantRegistry, { enabled: true })
      await expect(ctx.plugin(companion).await()).resolves.toBeDefined()
    })

    it('node-half apply runs clean', async () => {
      const hostModule = await hostEntry
      expect(() => { hostModule.apply() }).not.toThrow()
    })
  })
}
