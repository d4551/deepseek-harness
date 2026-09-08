import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Tests owning the utility and conversation-linked Team mutation scope. */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: [
      'packages/util/*/tests/**/*.spec.ts',
      'packages/api/session-controller/tests/**/*.spec.{ts,tsx}',
      'packages/subagent/agent-team/tests/**/*.spec.ts',
      'packages/client/ui-agent-team/tests/**/*.spec.{ts,tsx}',
      'packages/client/ui-subagent/tests/**/*.spec.{ts,tsx}',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
