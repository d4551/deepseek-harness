import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestCacheDir, vitestExecArgv, vitestFsModuleCachePath } from './vitest.shared.ts'

/** Complete owning suites for approval policy and authorization boundaries. */
export default defineConfig({
  cacheDir: vitestCacheDir,
  resolve: { tsconfigPaths: true },
  plugins: [standardDecoratorPlugin()],
  test: {
    fsModuleCachePath: vitestFsModuleCachePath,
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: ['packages/guard/approval-adversary/tests/**/*.spec.ts', 'packages/guard/approval-assessor/tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
