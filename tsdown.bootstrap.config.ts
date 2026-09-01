import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import { buildToolingWorkspace } from './scripts/build-tooling-closure.ts'
import { WORKSPACE_BUNDLE_OPTIONS } from './scripts/tsdown-workspace-options.ts'

/**
 * The pass that makes `tsdown.config.ts` loadable.
 *
 * That config imports the Typert plugin from the generator's `lib/types`
 * emit, and Node resolves the plugin's whole import graph before the Host
 * build starts. A workspace package in that graph resolves to its
 * `lib/index.js` bundle, which no pass has written yet on a tree built from a
 * clean checkout. This pass bundles exactly those packages and loads no
 * plugin of its own, so the Host pass that follows can load its config.
 *
 * The package list is derived from the Host config's imports and the declared
 * workspace dependencies behind them, so adding one to the build tooling
 * needs no edit here.
 */
export default defineConfig({
  ...WORKSPACE_BUNDLE_OPTIONS,
  workspace: buildToolingWorkspace(
    import.meta.dirname,
    readFileSync(new URL('tsdown.config.ts', import.meta.url), 'utf8'),
  ),
})
