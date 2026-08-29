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
  // Recorded score for this scope: 96.92 — 780 killed plus 7 timed out of 812
  // reachable mutants. One mutant is worth 0.1232 points here, so `break` sits
  // one mutant below the record: 787 detected scores 96.92 and 786 scores
  // 96.80, which this rejects. Killed and timed-out both count as detected, so
  // the split between them moving does not shift the score. It only moves up.
  //
  // The suffix retention is exact-window: push() retains only the bytes
  // finish() reads, so the trim is load-bearing output logic and its mutants
  // die under the behavior suite (that refactor took the scope from 96.57 to
  // 96.92 and timeout to 100). The 25 survivors are the equivalent floor:
  // scan-back caps and intent returns in the UTF-8 cut helpers (bounds on work,
  // documented spec facts), guards subsumed only through undefined-arithmetic
  // the guards exist to avoid relying on, a fast-path gate that keeps the
  // head strategy off the suffix arithmetic, a catch whose `false` the caller
  // reads only for falsiness, a fold direction no public surface exposes, and
  // loop or spread boundaries whose alternate form stores or spreads an empty
  // value. Raising the score past this means widening the scope, not weakening
  // this number.
  thresholds: { high: 100, low: 96.8, break: 96.8 },
  // Agent-session state and build output are not project sources; Stryker copies
  // the working tree into its sandbox, and `.claude/skills` is a directory
  // symlink its file copier cannot follow.
  ignorePatterns: ['.claude', '.agents/worktrees', 'coverage', '.artifacts', 'dist-exe', '.dsh-build'],
  timeoutMS: 60000,
  concurrency: 4,
  tempDirName: 'node_modules/.stryker-tmp',
  cleanTempDir: true,
}
