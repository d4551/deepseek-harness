import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestCacheDir, vitestExecArgv, vitestFsModuleCachePath } from './vitest.shared.ts'
import { clientBrowserTests } from './vitest.client-browser.ts'
import { COVERAGE_SOURCE_GLOB } from './scripts/coverage-debt.ts'
import { processBoundTests as inventoryProcessBoundTests } from './scripts/vitest-inventory.ts'

// Istanbul loads custom reporters by absolute path through require().
const uncoveredLocationsReporter = fileURLToPath(new URL('./scripts/coverage-uncovered-locations.cjs', import.meta.url))
const testIncludes = [
  'packages/*/*/tests/**/*.spec.{ts,tsx}',
  'apps/*/tests/**/*.spec.ts',
  'scripts/**/*.spec.ts',
]
const gateEnv = loadEnv('test', fileURLToPath(new URL('.', import.meta.url)), '')
const persistTransforms = gateEnv.CI === undefined
const processBoundTests = [
  ...inventoryProcessBoundTests,
  'packages/llm/llm-pi-ai/tests/adapter.spec.ts',
]

// Each fork loads the workspace graph; bound parallelism to limit resident memory.
const MAX_TEST_FORKS = Math.max(2, Math.min(availableParallelism(), 8))

export default defineConfig({
  cacheDir: vitestCacheDir,
  resolve: { tsconfigPaths: true },
  plugins: [standardDecoratorPlugin()],
  test: {
    reporters: ['default', './scripts/client-a11y-reporter.ts'],
    setupFiles: ['./scripts/test-invariants.ts'],
    testTimeout: 30_000,
    maxWorkers: MAX_TEST_FORKS,
    fsModuleCache: persistTransforms,
    fsModuleCachePath: vitestFsModuleCachePath,
    include: testIncludes,
    projects: [
      {
        extends: false,
        cacheDir: vitestCacheDir,
        resolve: { tsconfigPaths: true },
        plugins: [standardDecoratorPlugin()],
        test: {
          name: 'thread-safe',
          execArgv: vitestExecArgv,
          // Shell and watcher tests run after this group to avoid timing contention.
          sequence: { groupOrder: 0 },
          // Forks isolate Node's CJS parser and each suite's process state.
          pool: 'forks',
          setupFiles: ['./scripts/test-invariants.ts'],
          testTimeout: 30_000,
          maxWorkers: MAX_TEST_FORKS,
          fsModuleCache: persistTransforms,
          include: testIncludes,
          // Every routed suite runs in the process-bound or browser project below.
          exclude: [...processBoundTests, ...clientBrowserTests],
        },
      },
      {
        extends: false,
        cacheDir: vitestCacheDir,
        resolve: { tsconfigPaths: true },
        plugins: [standardDecoratorPlugin()],
        test: {
          name: 'process-bound',
          execArgv: vitestExecArgv,
          sequence: { groupOrder: 1 },
          pool: 'forks',
          setupFiles: ['./scripts/test-invariants.ts'],
          testTimeout: 30_000,
          maxWorkers: 1,
          fsModuleCache: persistTransforms,
          include: processBoundTests,
          exclude: clientBrowserTests,
        },
      },
      './vitest.client-browser.config.ts',
    ],
    coverage: {
      provider: 'v8',
      autoAttachSubprocess: true,
      reportOnFailure: true,
      include: [COVERAGE_SOURCE_GLOB],
      exclude: [],
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      reporter: gateEnv.CI
        ? ['text', uncoveredLocationsReporter]
        : ['text', 'html', uncoveredLocationsReporter],
    },
  },
})
