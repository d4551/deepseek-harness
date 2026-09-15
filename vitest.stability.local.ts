import { globSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'
import { clientBrowserTests } from './vitest.client-browser.ts'

const tests = globSync('packages/client/{ui-primitives,ui-agent-team,ui-settings-plugins}/tests/**/*.spec.{ts,tsx}')
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    projects: [
      { extends: true, test: { name: 'stability-node', include: tests.filter(file => !clientBrowserTests.includes(file)) } },
      { extends: './vitest.client-browser.config.ts', test: { name: 'stability-browser', include: tests.filter(file => clientBrowserTests.includes(file)) } },
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
