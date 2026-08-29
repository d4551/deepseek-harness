/**
 * Mutation testing over the harness source, run with the Vitest runner.
 *
 * `mutate` is the ratchet: the per-file 100% line-coverage gate proves every
 * line executes, and mutation score proves an assertion would notice if the
 * line were wrong. The scope starts at the zero-dependency utility tier — the
 * code every other package builds on — and widens as each added tier reaches
 * the threshold. `break` equals the recorded score for the current scope, so a
 * regression fails the run rather than being averaged away.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  // `packageManager` is deliberately unset: Stryker only accepts npm, yarn, or
  // pnpm there, and it governs nothing but its offer to install missing
  // plugins — which this workspace already declares.
  testRunner: 'vitest',
  // Named rather than left to the default `@stryker-mutator/*` glob: the
  // isolated node_modules layout keeps each plugin behind its own store
  // directory, which the glob does not walk.
  plugins: ['@stryker-mutator/vitest-runner'],
  // `related: false` because the suites import their subject by package name
  // through tsconfig paths, which Vitest's related-file heuristic does not
  // follow; the mutation config narrows the run instead.
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  // The suites reach their subject through tsconfig path aliases, which the
  // per-test coverage attribution does not follow: it reported mutants as
  // survived that fail the suite when applied by hand. The scoped run is small
  // enough to execute in full for every mutant.
  coverageAnalysis: 'all',
  reporters: ['progress', 'clear-text', 'json'],
  jsonReporter: { fileName: '.artifacts/mutation/mutation.json' },
  mutate: [
    'packages/util/*/src/**/*.ts',
    '!packages/util/*/src/types.ts',
  ],
  // Recorded score for this scope: 95.98 (780 killed + 7 timeout of 820
  // reachable mutants). `break` sits just under it so ordinary noise does not
  // fail the run while any real regression does; it only ever moves up.
  //
  // The 33 survivors are not missing assertions. They are mutants no output
  // assertion can reach: the suffix accumulator's trim is a documented memory
  // bound that `finish()` never reads past, `clearTimeout(undefined)` and a
  // second `dispose()` are no-ops, `mkdir({ mode: undefined })` is the default,
  // the UTF-8 scanner's scan-back cap bounds work rather than output, and the
  // Windows file-as-parent probe needs Windows. Raising the score means
  // removing that code or widening the scope, not weakening this number.
  thresholds: { high: 100, low: 95, break: 95 },
  // Agent-session state and build output are not project sources; Stryker copies
  // the working tree into its sandbox, and `.claude/skills` is a directory
  // symlink its file copier cannot follow.
  ignorePatterns: ['.claude', '.agents/worktrees', 'coverage', '.artifacts', 'dist-exe', '.dsh-build'],
  timeoutMS: 60000,
  concurrency: 4,
  tempDirName: 'node_modules/.stryker-tmp',
  cleanTempDir: true,
}
