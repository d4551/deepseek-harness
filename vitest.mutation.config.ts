import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/**
 * The suite Stryker runs against each mutant.
 *
 * It includes the tests owned by the packages under mutation and nothing else.
 * A mutant a consumer's suite would have killed therefore survives here, so
 * this scoping can only lower the mutation score, never inflate it. Widening
 * `mutate` in stryker.config.mjs means widening `include` here to match.
 */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: ['packages/util/*/tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
