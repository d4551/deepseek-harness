import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestCacheDir, vitestFsModuleCachePath } from './vitest.shared.ts'
import { clientBrowserTests } from './vitest.client-browser.ts'
import { clientBuildEnvironmentDefines } from './scripts/client-build-environment.ts'

export default defineConfig({
  cacheDir: vitestCacheDir,
  resolve: { tsconfigPaths: true },
  define: clientBuildEnvironmentDefines(process.env),
  plugins: [standardDecoratorPlugin()],
  optimizeDeps: { entries: clientBrowserTests },
  test: {
    fsModuleCachePath: vitestFsModuleCachePath,
    name: 'client-browser',
    include: clientBrowserTests,
    testTimeout: 30_000,
    fileParallelism: false,
    sequence: { groupOrder: 2 },
    setupFiles: ['packages/test-support/client-a11y/tests/browser-setup.client.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
})
