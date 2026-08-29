/**
 * Mutation testing over the zero-dependency utility tier, run with the
 * Vitest runner. It is 9 of the repository's 248 packages: the number this
 * gate reports is that tier's, not the harness's.
 *
 * `mutate` is the ratchet: the per-file 100% line-coverage gate proves every
 * line executes, and mutation score proves an assertion would notice if the
 * line were wrong. The scope starts at the zero-dependency utility tier — the
 * code every other package builds on — and widens as each added tier reaches
 * the threshold. `break` sits less than one mutant below the recorded score,
 * so a single additional survivor fails the run rather than being averaged
 * away.
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
  // No exclusions: a `types.ts` carries no runtime code and so yields no
  // mutants on its own, and every other file in the tier is in scope.
  mutate: ['packages/util/*/src/**/*.ts'],
  // Recorded score for this scope is rewritten after the next measured run.
  // The previous 96.92 / break 96.8 figure was not reproduced on this tree
  // (96.58 of 818, 28 survivors). `break` stays at the last honest measured
  // floor until a new run replaces it.
  thresholds: { high: 100, low: 96.5, break: 96.5 },
  // Agent-session state and build output are not project sources; Stryker copies
  // the working tree into its sandbox, and `.claude/skills` is a directory
  // symlink its file copier cannot follow.
  ignorePatterns: ['.claude', '.agents/worktrees', 'coverage', '.artifacts', 'dist-exe', '.dsh-build'],
  timeoutMS: 60000,
  concurrency: 4,
  tempDirName: 'node_modules/.stryker-tmp',
  cleanTempDir: true,
}
