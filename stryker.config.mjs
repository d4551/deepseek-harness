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
  // Recorded score from the 2026-08-30 measured run: 99.08 (757 detected of
  // 764; 7 survivors, each verified equivalent in context — a lock-contention
  // catch arm whose sole call site reads truthiness, a loop bound whose extra
  // iteration slices an empty range, a symmetric case-fold, a regex
  // replacement whose block is extracted by a later regex regardless, a
  // missing-block early return whose subsequent match returns the same
  // undefined, an out-of-bounds walk exit, and a lead byte the walk cannot
  // stop on).
  // One mutant is 0.131%, so break 98.9 fails on the second new survivor.
  thresholds: { high: 100, low: 98.9, break: 98.9 },
  // Agent-session state and build output are not project sources; Stryker copies
  // the working tree into its sandbox, and `.claude/skills` is a directory
  // symlink its file copier cannot follow.
  ignorePatterns: ['.claude', '.agents/worktrees', 'coverage', '.artifacts', 'dist-exe', '.dsh-build'],
  timeoutMS: 60000,
  concurrency: 4,
  tempDirName: 'node_modules/.stryker-tmp',
  cleanTempDir: true,
}
