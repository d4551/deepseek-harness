/**
 * Per-package bundle options shared by the Host tsdown pass and the
 * build-tooling bootstrap pass that precedes it. Both passes write the same
 * `lib/*.js` files for a package they both cover, so the options have one
 * home and the second pass cannot drift into producing a different bundle.
 */

import type { UserConfig } from 'tsdown'

/**
 * Entries and output settings every workspace package bundles under. Package-local
 * `tsdown.config.ts` files override these for their own phase selection.
 */
export const WORKSPACE_BUNDLE_OPTIONS = {
  entry: ['lib/types/{index,invariant,startup}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
} satisfies UserConfig
