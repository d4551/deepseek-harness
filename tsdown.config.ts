import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'
import { WORKSPACE_BUNDLE_OPTIONS } from './scripts/tsdown-workspace-options.ts'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 *
 * Node resolves the Typert plugin's whole import graph while this file loads,
 * before the build writes anything, so `tsdown.bootstrap.config.ts` bundles
 * the workspace packages that graph reaches first.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    ...WORKSPACE_BUNDLE_OPTIONS,
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: client ? '' : WORKSPACE_BUNDLE_OPTIONS.entry,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
