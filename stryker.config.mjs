/**
 * Mutation testing for utilities and conversation-linked Agent Teams.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'vitest',
  plugins: [import.meta.resolve('@stryker-mutator/vitest-runner')],
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  coverageAnalysis: 'perTest',
  disableTypeChecks: false,
  reporters: ['progress', 'clear-text', 'json', 'event-recorder'],
  jsonReporter: { fileName: '.artifacts/mutation/mutation.json' },
  eventReporter: { baseDir: '.artifacts/mutation/events' },
  mutate: [
    'packages/util/*/src/**/*.ts',
    'packages/api/remotes/src/index.ts',
    'packages/api/session-controller/src/control.ts',
    'packages/api/session-controller/src/client/sessions/manager.ts',
    'packages/api/session-controller/src/client/sessions/list-mutations.ts',
    'packages/subagent/agent-team/src/**/*.ts',
    'packages/subagent/tool-agent-team/src/**/*.ts',
    'packages/client/ui-agent-team/src/client/**/*.{ts,tsx}',
    'packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx',
    'packages/guard/approval-adversary/src/**/*.ts',
    'packages/guard/approval-assessor/src/**/*.ts',
  ],
  thresholds: { high: 100, low: 99, break: 99 },
  ignorePatterns: ['.claude', '.agents/worktrees', '.cache', 'coverage', '.artifacts', 'dist-exe', '.dsh-build', '.audit-tmp'],
  timeoutMS: 60000,
  concurrency: 4,
  tempDirName: '.artifacts/mutation/sandbox',
  cleanTempDir: true,
}
