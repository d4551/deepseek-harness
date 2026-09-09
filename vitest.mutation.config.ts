import { globSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'
import { clientBrowserTests } from './vitest.client-browser.ts'

const mutationTests = globSync([
  'packages/util/*/tests/**/*.spec.ts',
  'packages/api/remotes/tests/**/*.spec.ts',
  'packages/api/session-controller/tests/**/*.spec.{ts,tsx}',
  'packages/subagent/agent-team/tests/**/*.spec.ts',
  'packages/client/ui-agent-team/tests/**/*.spec.{ts,tsx}',
  'packages/client/ui-subagent/tests/**/*.spec.{ts,tsx}',
]).map(file => file.replaceAll('\\', '/'))

/** Tests owning the utility and conversation-linked Team mutation scope. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'mutation-node',
          include: mutationTests.filter(file => !clientBrowserTests.includes(file)),
        },
      },
      {
        extends: './vitest.client-browser.config.ts',
        test: {
          name: 'mutation-browser',
          include: mutationTests.filter(file => clientBrowserTests.includes(file)),
          provide: { strykerActiveMutant: process.env.__STRYKER_ACTIVE_MUTANT__ },
          setupFiles: ['./scripts/mutation-browser-setup.ts'],
        },
      },
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
