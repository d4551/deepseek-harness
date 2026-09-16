import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestCacheDir, vitestExecArgv, vitestFsModuleCachePath } from './vitest.shared.ts'

/** Owner-local assembled expected-output tests that do not use a recorded session as their input. */
export default defineConfig({
  cacheDir: vitestCacheDir,
  resolve: { tsconfigPaths: true },
  plugins: [standardDecoratorPlugin()],
  test: {
    fsModuleCachePath: vitestFsModuleCachePath,
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: [
      'apps/cli/tests/**/*.expected.e2e.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    maxWorkers: Math.min(5, availableParallelism()),
  },
})
