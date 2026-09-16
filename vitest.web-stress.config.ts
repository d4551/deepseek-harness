import { defineConfig } from 'vitest/config'
import { vitestCacheDir, vitestExecArgv, vitestFsModuleCachePath } from './vitest.shared.ts'

/** Opt-in browser performance lane; no default Vitest config includes *.stress.ts. */
export default defineConfig({
  cacheDir: vitestCacheDir,
  resolve: { tsconfigPaths: true },
  test: {
    fsModuleCachePath: vitestFsModuleCachePath,
    execArgv: vitestExecArgv,
    include: ['apps/web/stress-tests/**/*.stress.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
