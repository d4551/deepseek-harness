import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Built-artifact lane (see AGENTS.md "Source plane vs artifact plane"): suites
// that consume emitted `lib/` bundles from the real workspace composition.
// Every gate that runs this config declares the finished `build` it needs, so
// these suites run unconditionally instead of self-skipping on an unbuilt
// tree — that is why they live outside the default `**/*.spec.ts` include of
// vitest.config.ts and carry no `DSH_REQUIRE_BUILT_PACKAGES` check.
export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the tsconfig.base.json paths facade to `src`, never to built
  // dist exports; the built-ness under test lives in the packed image's own
  // file bytes and createRequire lookups, which bypass vite resolution.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: ['packages/*/*/tests/**/*.built.ts'],
    // Packing a workspace package, lowering it, tarring, and inflating the
    // archive is process-heavy per case; the unit lane's 30s budget does not
    // hold. No coverage — the unit suites own the coverage gate.
    testTimeout: 120_000,
    pool: 'forks',
  },
})
