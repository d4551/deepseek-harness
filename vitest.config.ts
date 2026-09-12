import { spawnSync } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'
import { clientBrowserTests } from './vitest.client-browser.ts'
import { COVERAGE_EXEMPT_ENV, coverageExemptHeavySuites } from './scripts/coverage-exempt.ts'
import { COVERAGE_PARTITION_MODE_ENV } from './scripts/coverage-partitions.ts'
import { resolvePwshPath } from './packages/shell/pwsh-local/src/resolve.ts'
import { PWSH_COVERAGE_SOURCES, WINDOWS_ONLY_COVERAGE_SOURCES, WINDOWS_RUNNER_COVERAGE_SOURCES, nonLinuxTests, processBoundTests as inventoryProcessBoundTests, windowsTestExclusions, windowsUnsupportedPackages } from './scripts/vitest-inventory.ts'

// Prints exact `path:line:col` records for every uncovered statement, branch
// path, and function when a file misses the per-file 100% gate — the built-in
// threshold ERRORs name only the file. Absolute path because istanbul-reports
// require()s custom reporters (which is also why the reporter is CJS).
const uncoveredLocationsReporter = fileURLToPath(new URL('./scripts/coverage-uncovered-locations.cjs', import.meta.url))

// The win32 lane's suite exclusions and the off-Linux webworker suites live
// in vitest-inventory.ts with their reasons; each list is empty on the
// platforms it does not concern.
const platformUnsupportedTests = windowsTestExclusions.concat(nonLinuxTests)
// Coverage follows the test lane: a package qualifies here only because NO
// suite of its own runs on win32 (the same list, with the same reasons), so
// its sources cannot be covered there. A package whose suites do run states a
// per-file reason below or meets the gate.
const windowsUnsupportedCoveragePackages = process.platform === 'win32'
  ? windowsUnsupportedPackages
  : []

// Windows-only packages: their sources execute exclusively on win32 (koffi
// loads Win32 libraries), so the Linux coverage lane can never cover them.
// The Windows dev/CI lane exercises them through the probe/runner suites; the
// per-file 100% gate must not fail on their Linux-uncovered paths.
const windowsOnlyCoverageExclusions = process.platform !== 'win32'
  ? WINDOWS_ONLY_COVERAGE_SOURCES
  : []

// The confinement runner entry executes exclusively as a spawned child
// process (the sandbox seam prefixes child argv with this entry): its
// module-level main() would run the confinement in-process if imported, and
// vitest's v8 coverage never measures child processes. Its behavior is pinned
// end-to-end by tests/runner.spec.ts, which spawns the real entry through tsx.
const windowsRunnerCoverageExclusions = process.platform === 'win32'
  ? WINDOWS_RUNNER_COVERAGE_SOURCES
  : []

// pwsh-local's run/start/lifecycle suites self-skip without a real pwsh
// (executor.spec.ts hasPwsh), leaving these files
// far below per-file 100% on pwsh-less hosts; the exemption keeps those hosts
// green while CI runners ship pwsh and still enforce the full bar. The probe
// runs the suites' own resolution (the dependency-free resolve.ts module),
// so the exemption is active exactly when the suites skip — a mismatched
// narrower probe could exempt the files on hosts whose suites actually run.
const pwshCoverageExclusions = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
  ? []
  : PWSH_COVERAGE_SOURCES

const testIncludes = [
  'packages/*/*/tests/**/*.spec.{ts,tsx}',
  'apps/*/tests/**/*.spec.ts',
  'scripts/**/*.spec.ts',
]

// The instrumented coverage gate sets this env; the exempt heavy suites then
// run beside it uninstrumented (membership contract in scripts/coverage-exempt.ts).
// A set-but-not-'1' value is a misconfiguration, not a silent no-op.
// Vitest lanes run under mode 'test', so vite's validated env loader is the
// one source for every gate switch this config reads.
const gateEnv = loadEnv('test', fileURLToPath(new URL('.', import.meta.url)), '')
const coverageExemptRaw = gateEnv[COVERAGE_EXEMPT_ENV]
if (coverageExemptRaw !== undefined && coverageExemptRaw !== '' && coverageExemptRaw !== '1') {
  throw new Error(`vitest config: ${COVERAGE_EXEMPT_ENV} must be '1' or unset, got ${JSON.stringify(coverageExemptRaw)}.`)
}
const coverageExemptExcludes = coverageExemptRaw === '1'
  ? coverageExemptHeavySuites.map(suite => suite.exclude)
  : []

const coveragePartitionRaw = gateEnv[COVERAGE_PARTITION_MODE_ENV]
if (coveragePartitionRaw !== undefined && coveragePartitionRaw !== '' && coveragePartitionRaw !== '1') {
  throw new Error(`vitest config: ${COVERAGE_PARTITION_MODE_ENV} must be '1' or unset, got ${JSON.stringify(coveragePartitionRaw)}.`)
}
const coveragePartitionMode = coveragePartitionRaw === '1'

// Transformed modules persist under node_modules between runs on a developer
// host, where the transform was the largest share of a scoped rerun's wall
// clock. Vitest keys each entry by file content and by the environment
// config, and its v8 provider bypasses the cache inside workers, so the
// coverage gate measures uncached source either way. CI starts from a fresh
// checkout, where nothing survives to be reused; `vitest --clearCache`
// discards the entries by hand. Projects extend nothing, so each declares it.
const persistTransforms = gateEnv.CI === undefined

// Process-bound selection: the shared inventory (vitest-inventory.ts) lists
// the suites exercising process-global state, process APIs, or timing-
// sensitive process I/O that worker threads cannot isolate reliably under
// aggregate gate contention; the live-provider entry below stays local.
const processBoundTests = [
  ...inventoryProcessBoundTests,
  'packages/llm/llm-pi-ai/tests/adapter.spec.ts',
]

/**
 * Fork-pool ceiling. Every worker is a full Node process that loads the
 * workspace graph, so an uncapped default on a many-core host spawns more
 * heavyweight forks than the machine has memory for and they are killed
 * mid-run — the same trade `run-gates.ts` caps for the doc gates. Small hosts
 * and CI runners stay uncapped; only large ones bind.
 */
const MAX_TEST_FORKS = Math.max(2, Math.min(availableParallelism(), 8))

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [standardDecoratorPlugin()],
  test: {
    setupFiles: ['./scripts/test-invariants.ts'],
    // Every other lane declares its own budget (e2e/expected/snapshot 120s, web
    // 180s, mutation 30s); this one ran on vitest's 5s default. Specs here spawn
    // git, node, bun, and oxlint, which exceed 5s under the fork pool's
    // parallelism while still failing fast on a real hang.
    testTimeout: 30_000,
    maxWorkers: MAX_TEST_FORKS,
    fsModuleCache: persistTransforms,
    // .tsx: client component specs (jsdom via per-file @vitest-environment pragma).
    include: testIncludes,
    exclude: platformUnsupportedTests,
    // One coverage invocation aggregates Node and native browser projects.
    projects: [
      {
        extends: false,
        resolve: { tsconfigPaths: true },
        plugins: [standardDecoratorPlugin()],
        test: {
          name: 'thread-safe',
          execArgv: vitestExecArgv,
          // Runs before the process-bound group, never beside it: those suites
          // measure live shells, watchers, and Workers against per-command
          // budgets, which this pool's forks exhaust when both run at once.
          sequence: { groupOrder: 0 },
          // Node 24 has aborted in its CJS lexer (v8::ToLocalChecked Empty
          // MaybeLocal in cjs_lexer::Parse) from worker threads on macOS,
          // Linux, and Windows. Forked workers avoid that shared thread path.
          pool: 'forks',
          setupFiles: ['./scripts/test-invariants.ts'],
          // Projects do not inherit the root lane budget; see the note there.
          testTimeout: 30_000,
          maxWorkers: MAX_TEST_FORKS,
          fsModuleCache: persistTransforms,
          include: testIncludes,
          exclude: [
            ...platformUnsupportedTests,
            ...processBoundTests,
            ...coverageExemptExcludes,
            ...clientBrowserTests,
          ],
        },
      },
      {
        extends: false,
        resolve: { tsconfigPaths: true },
        plugins: [standardDecoratorPlugin()],
        test: {
          name: 'process-bound',
          execArgv: vitestExecArgv,
          sequence: { groupOrder: 1 },
          pool: 'forks',
          setupFiles: ['./scripts/test-invariants.ts'],
          // Projects do not inherit the root lane budget; see the note there.
          testTimeout: 30_000,
          // One fork at a time. These suites hold process-global state and
          // measure live shells and process trees against per-command budgets;
          // running two of them together spends the budget on contention, which
          // reports as a timeout in whichever suite lost the race.
          maxWorkers: 1,
          fsModuleCache: persistTransforms,
          include: processBoundTests,
          exclude: [
            ...platformUnsupportedTests,
            ...coverageExemptExcludes,
            ...clientBrowserTests,
          ],
        },
      },
      './vitest.client-browser.config.ts',
    ],
    coverage: {
      provider: 'v8',
      // Emit the report even when tests fail. Vitest defaults this off, so a
      // single failing test left the per-file gate with no verdict at all
      // rather than a failing one — three unrelated failures blinded it for a
      // whole session. `scripts/coverage-partitions.ts` already passes
      // `--coverage.reportOnFailure` for the sharded lane; this is the same
      // decision for the plain one. It relaxes no threshold.
      reportOnFailure: true,
      // Coverage measures OUR runtime source. Types-only files carry no
      // executable code; vendor/ and application/config fixtures are excluded
      // because they are not authored runtime code here.
      // .tsx: client components are gated like everything else (jsdom lane).
      include: ['packages/*/*/src/**/*.{ts,tsx}'],
      // Types-only files have no runtime coverage. Importing self-executing bins/workers would boot
      // them inside the unit process, so real subprocess/Worker tests cover their thin entry glue.
      // `bun run verify-coverage-debt` reads this list back (structural or marked, naming files,
      // not covered by another entry); `bun run measure-coverage-debt` measures the debt.
      exclude: [
        'packages/*/*/src/types.ts',
        'packages/*/*/src/bin.ts',
        'packages/*/*/src/worker.ts',
        // A killed executable lint-contract test can leave a non-product source probe behind.
        'packages/*/*/src/oxlint-contract-*.ts',
        // DEBT(gui): client/web UI files whose remaining branches need a
        // browser-grade harness the jsdom lane does not cover; the client test
        // lane maturing removes these entries.
        'packages/client/ui-trajectory/src/*',
        // DEBT(gui): Trajectory's compact Markdown projection and the surfaces
        // below retain deferred branch coverage on the same lane.
        'packages/client/ui-primitives/src/markdown/plain-text.ts',
        'packages/client/ui-user-questions/src/client/QuestionComposer.tsx',
        'packages/client/ui-primitives/src/Menu.tsx',
        'packages/client/ui-primitives/src/RiskConfirmation.tsx',
        'packages/client/ui-workspace/src/client/WorkspacePicker.tsx',
        'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx',
        'packages/client/ui-renderer/src/client/*',
        // DEBT(gui): Session object internals retain the runtime GUI debt
        // exemption; the Controller entry, transport, and Agent scope stay
        // gated.
        'packages/api/session-controller/src/client/sessions/*',
        // DEBT(gui): the browser conversation tree keeps its GUI debt
        // exemption while the stateful Host half and vocabulary stay gated.
        'packages/client/ui-conversation/src/client/*',
        // DEBT(gui): chat presentation and assembly keep the same GUI debt
        // exemption; package wiring and the approval-detail module stay gated.
        'packages/client/ui-chat/src/client/chat/!(ApprovalCommand).{ts,tsx}',
        'packages/client/ui-chat/src/client/conversation-nodes/*',
        'packages/client/ui-chat/src/client/details/*',
        'packages/client/ui-chat/src/client/model/*',
        'packages/client/ui-chat/src/client/contract/snapshot.ts',
        'packages/client/ui-primitives/src/DisclosureRow.tsx',
        'packages/client/ui-tool/src/*',
        'packages/client/ui-slots/src/*',
        'packages/client/ui-layout/src/*',
        'packages/client/web/src/*',
        'packages/host/webserver/src/*',
        // DEBT(webworker): the browser-worker runtime and its image packer.
        // The executing composition is a real dedicated Worker driven by the web
        // browser lane (apps/web/tests/preview-boot.e2e.ts), which unit-process
        // V8 coverage cannot observe. Unit specs cover the algorithmic cores and
        // that boot is the assembled evidence; a browser-grade coverage lane
        // revisits these entries.
        'packages/experimental/webworker-runtime/src/**',
        'packages/experimental/webworker-packer/src/*',
        // Inspector execution adapters run in a Node Worker, the Host native
        // inspector session, or a browser realm, outside attributable parent
        // Vitest coverage.
        'packages/experimental/inspector/src/client/**',
        'packages/experimental/inspector/src/host/bridge/**',
        'packages/experimental/inspector/src/host/cdp/**',
        'packages/experimental/inspector/src/worker/bridge/**',
        'packages/experimental/inspector/src/worker/cdp/**',
        'packages/experimental/inspector/src/worker/realms/**',
        'packages/experimental/inspector/src/worker/{entry,server}.ts',
        // DEBT(inspector): already-complete Inspector modules stay under the
        // per-file gate; the remaining direct-test debt is enumerated rather
        // than exempting src/**. Closing these branch gaps removes the entries
        // below.
        'packages/experimental/inspector/src/shared/bridge/{control-codec,rpc}.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/observation.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/query/codec.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/runtime/{command-codec,console-frames,frames,value-codec}.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/sources/{codec,frames}.ts',
        'packages/experimental/inspector/src/worker/inspection/{cordis-store,query-router,realm-store}.ts',
        'packages/client/modules/src/client/system.ts',
        'packages/client/hmr/src/client/index.ts',
        // DEBT(gui): the host-side web-transport halves, whose remaining
        // branches need real-composition/process harnesses; the client test lane
        // maturing removes these entries.
        'packages/client/modules/src/index.ts',
        'packages/client/modules/src/invariant.ts',
        'packages/client/modules/src/client/manifest.ts',
        'packages/client/hmr/src/index.ts',
        'packages/client/hmr/src/invariant.ts',
        'packages/client/connection/src/index.ts',
        'packages/client/connection/src/http-bridge.ts',
        // This assembly imports generated Host-for-Client code that exists
        // only in lib; the post-build built-bin smoke executes both entries.
        'packages/api/remotes/src/index.ts',
        'packages/api/remotes/src/client/index.ts',
        // The Team browser entry binds its source-covered mount lifecycle to
        // the generated Team Remote contribution, which likewise exists only in lib.
        'packages/client/ui-agent-team/src/client/index.ts',
        // DEBT(gui): slash/command/input per-file gaps, deferred with the same
        // client-lane debt; that lane maturing removes these entries.
        'packages/client/connection/src/client/fixture.ts',
        'packages/client/ui-commands/src/index.ts',
        'packages/client/ui-skill/src/index.ts',
        'packages/client/ui-input-trigger/src/index.ts',
        'packages/client/ui-subagent/src/index.ts',
        'packages/client/ui-commands/src/client/service.ts',
        'packages/client/ui-commands/src/client/PopupSelectView.tsx',
        'packages/client/ui-model-selection/src/index.ts',
        'packages/client/ui-permission-presets/src/index.ts',
        'packages/client/ui-model-selection/src/client/ModelSelect.tsx',
        'packages/client/ui-model-selection/src/client/directory.ts',
        'packages/client/ui-model-selection/src/client/index.ts',
        'packages/client/ui-model-selection/src/client/service.ts',
        'packages/client/ui-input-trigger/src/client/controller.ts',
        'packages/client/ui-input-trigger/src/client/service.ts',
        'packages/client/ui-input-trigger/src/core/menu.ts',
        'packages/client/ui-skill/src/client/index.ts',
        'packages/client/ui-workspace/src/client/index.ts',
        'packages/client/ui-primitives/src/JsonTree.tsx',
        'packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx',
        // DEBT(gui): the Cordis extension group's per-file gaps, enumerated rather than
        // matched by a `packages/extensions/*` glob. The glob sat at the tail
        // of the client slash/command block and inherited a comment that
        // described none of it, so an entire package group left the gate
        // silently and any file added to it left too. Measured at enumeration:
        // 57.91% statements over 45 files, 12 of them already meeting every
        // threshold and now gated. Deleting an entry is how a file rejoins.
        'packages/extensions/cordis-client-runner/src/client/api-catalog.ts',
        'packages/extensions/cordis-client-runner/src/client/index.ts',
        'packages/extensions/cordis-client-runner/src/client/inspect-registry.ts',
        'packages/extensions/cordis-client-runner/src/client/orchestrator.ts',
        'packages/extensions/cordis-client-runner/src/client/providers.ts',
        'packages/extensions/cordis-client-runner/src/client/runtime.ts',
        'packages/extensions/cordis-client-runner/src/client/timer.ts',
        'packages/extensions/cordis-host-runner/src/guard.ts',
        'packages/extensions/cordis-host-runner/src/index.ts',
        'packages/extensions/cordis-host-runner/src/inspect-registry.ts',
        'packages/extensions/cordis-host-runner/src/sandbox.ts',
        'packages/extensions/tool-cordis/src/api-catalog.ts',
        'packages/extensions/tool-cordis/src/fiber-state.ts',
        'packages/extensions/tool-cordis/src/index.ts',
        'packages/extensions/tool-cordis/src/inspect.ts',
        'packages/extensions/tool-cordis/src/present.ts',
        'packages/extensions/tool-cordis/src/prompt.ts',
        'packages/extensions/tool-cordis/src/providers.ts',
        'packages/extensions/ui-cordis/src/client/CordisActionRow.tsx',
        'packages/extensions/ui-cordis/src/client/CordisDefineRow.tsx',
        'packages/extensions/ui-cordis/src/client/CordisPanel.tsx',
        'packages/extensions/ui-cordis/src/client/CordisRunRow.tsx',
        'packages/extensions/ui-cordis/src/client/index.ts',
        'packages/extensions/ui-cordis/src/client/locales.ts',
        'packages/extensions/ui-cordis/src/index.ts',
        'packages/extensions/ui-cordis/src/invariant.ts',
        // Typert generator: correctness is pinned by its fixture suites and
        // the byte-for-byte catalog reproduction test; per-file coverage
        // would put whole-workspace compiler analysis under v8
        // instrumentation — the coverage lane's longest tail.
        'packages/typert/generator/src/*.ts',
        // DEBT(gui): executor lifecycle branches and the registry's drive
        // tails need the same maturing lanes; those lanes maturing removes
        // these entries.
        'packages/interaction/commands/src/index.ts',
        'packages/session/session-projection/src/index.ts',
        ...windowsUnsupportedCoveragePackages.map(path => `${path}/src/**/*.ts`),
        ...windowsOnlyCoverageExclusions,
        ...windowsRunnerCoverageExclusions,
        ...pwshCoverageExclusions,
      ],
      // 100% or it doesn't merge (docs/testing.md: excessive tests are welcome).
      // Per-file so a well-covered big file can't subsidize a bare one.
      // Every v8 coverage exclusion comment must state its reason — see the quality-gates Agent Note
      // (.agents/notes/implemented/process/2026-06-11-quality-gates.md).
      thresholds: coveragePartitionMode
        ? undefined
        : {
            perFile: true,
            statements: 100,
            branches: 100,
            functions: 100,
            lines: 100,
          },
      reporter: coveragePartitionMode
        ? []
        : gateEnv.CI
          ? ['text', uncoveredLocationsReporter]
          : ['text', 'html', uncoveredLocationsReporter],
    },
  },
})
