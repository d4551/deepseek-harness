import { spawnSync } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'
import { COVERAGE_EXEMPT_ENV, coverageExemptHeavySuites } from './scripts/coverage-exempt.ts'
import { COVERAGE_PARTITION_MODE_ENV } from './scripts/coverage-partitions.ts'
import { resolvePwshPath } from './packages/shell/pwsh-local/src/resolve.ts'
import { nonLinuxTests, processBoundTests as inventoryProcessBoundTests, windowsPackageTestExclusions, windowsUnsupportedPackages } from './scripts/vitest-inventory.ts'

// Prints exact `path:line:col` records for every uncovered statement, branch
// path, and function when a file misses the per-file 100% gate — the built-in
// threshold ERRORs name only the file. Absolute path because istanbul-reports
// require()s custom reporters (which is also why the reporter is CJS).
const uncoveredLocationsReporter = fileURLToPath(new URL('./scripts/coverage-uncovered-locations.cjs', import.meta.url))

// Resolution facade shared by every plugin instance below: tsconfig.base.json
// has no include, which vite-tsconfig-paths treats as match-all, so its paths
// map applies to every test file. paths must win over package exports so built
// lib/ never loads a second module-singleton copy.
//
// Vite 8 prints a startup notice recommending its own resolve.tsconfigPaths in
// place of this plugin. It is not a swap here: the native option applies a
// config's paths only to the files that config matches through `files` or
// `include`, and tsconfig.base.json declares neither, so its 589 mappings would
// reach nothing. The match-all reading of a config without `include` is the
// behaviour this repository depends on, and only the plugin has it.
const pathsPlugin = (): ReturnType<typeof tsconfigPaths> => tsconfigPaths({ projects: ['./tsconfig.base.json'] })

// Win32 fact entries beyond the package list (which lives in
// vitest-inventory.ts with its rationale): these suites' oracle is the host's
// own POSIX semantics or the fixed-linux worker face, so Windows cannot host
// them. Every entry states the concrete Windows fact that keeps it out.
const windowsUnsupportedTests = process.platform === 'win32'
  ? [
      ...windowsPackageTestExclusions,
      // Oracle-diff suites: they compare the worker's POSIX path/url faces
      // and its implemented built-ins against the host Node's own answers,
      // which are win32 semantics on Windows. The worker always speaks POSIX;
      // the Linux lanes hold the diff. The glob covers path-diff, the
      // built-ins diff, and the crypto/url/util diff suites.
      'packages/experimental/webworker-runtime/tests/node/*-diff.spec.ts',
      // The subprocess ladder over the worker's child_process face: its kill
      // rung reaches the in-worker process table through `process.kill`,
      // which the ladder's win32 branch replaces with taskkill-by-real-pid —
      // undeliverable to a table pid. The worker host always reports 'linux',
      // so the Linux lanes hold the ladder.
      'packages/experimental/webworker-runtime/tests/node/child-process.spec.ts',
    ]
  : []

// These suites compare against or assemble the Worker's fixed Linux platform;
// the two entries live in vitest-inventory.ts. Host-native Windows and macOS
// behavior is not their oracle.
const nonLinuxWebWorkerTests = process.platform === 'linux'
  ? []
  : nonLinuxTests

const platformUnsupportedTests = windowsUnsupportedTests.concat(nonLinuxWebWorkerTests)
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
  ? ['packages/sandbox/sandbox-windows-acl/src/**/*.ts']
  : []

// The confinement runner entry executes exclusively as a spawned child
// process (the sandbox seam prefixes child argv with this entry): its
// module-level main() would run the confinement in-process if imported, and
// vitest's v8 coverage never measures child processes. Its behavior is pinned
// end-to-end by tests/runner.spec.ts, which spawns the real entry through tsx.
const windowsRunnerCoverageExclusions = process.platform === 'win32'
  ? ['packages/sandbox/sandbox-windows-acl/src/runner.ts']
  : []

// pwsh-local's run/start/lifecycle suites self-skip without a real pwsh
// (executor.spec.ts hasPwsh), leaving this file
// far below per-file 100% on pwsh-less hosts; the exemption keeps those hosts
// green while CI runners ship pwsh and still enforce the full bar. The probe
// runs the suites' own resolution (the dependency-free resolve.ts module),
// so the exemption is active exactly when the suites skip — a mismatched
// narrower probe could exempt the file on hosts whose suites actually run.
const pwshCoverageExclusions = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0
  ? []
  : [
      'packages/shell/pwsh-local/src/index.ts',
      'packages/shell/pwsh-sandbox/src/**/*.ts',
    ]

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
  plugins: [pathsPlugin(), standardDecoratorPlugin()],
  test: {
    setupFiles: ['./scripts/test-invariants.ts'],
    // Every other lane declares its own budget (e2e/expected/snapshot 120s, web
    // 180s, mutation 30s); this one ran on vitest's 5s default. Specs here spawn
    // git, node, bun, and oxlint, which exceed 5s under the fork pool's
    // parallelism while still failing fast on a real hang.
    testTimeout: 30_000,
    maxWorkers: MAX_TEST_FORKS,
    // .tsx: client component specs (jsdom via per-file @vitest-environment pragma).
    include: testIncludes,
    exclude: platformUnsupportedTests,
    // One coverage invocation aggregates both projects. Every suite forks for
    // Node stability; process-bound suites stay separate for inventory control.
    projects: [
      {
        extends: false,
        plugins: [pathsPlugin(), standardDecoratorPlugin()],
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
          include: testIncludes,
          exclude: [
            ...platformUnsupportedTests,
            ...processBoundTests,
            ...coverageExemptExcludes,
          ],
        },
      },
      {
        extends: false,
        plugins: [pathsPlugin(), standardDecoratorPlugin()],
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
          include: processBoundTests,
          exclude: [
            ...platformUnsupportedTests,
            ...coverageExemptExcludes,
          ],
        },
      },
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
      exclude: [
        'packages/*/*/src/types.ts',
        'packages/*/*/src/bin.ts',
        'packages/*/*/src/worker.ts',
        // Dynamic Host/Client composition is covered by its focused lifecycle
        // tests and assembled application checks rather than per-file coverage.
        'packages/self-modification/*/src/**/*.{ts,tsx}',
        // A killed executable lint-contract test can leave a non-product source probe behind.
        'packages/*/*/src/oxlint-contract-*.ts',
        // Client/web UI files whose remaining branches need a browser-grade
        // harness the jsdom lane does not cover; the client test lane
        // maturing removes these entries.
        'packages/client/ui-trajectory/src/*',
        // Trajectory's compact Markdown projection retains deferred branch coverage.
        'packages/client/ui-primitives/src/markdown/plain-text.ts',
        'packages/client/ui-user-questions/src/client/QuestionComposer.tsx',
        'packages/client/ui-primitives/src/Menu.tsx',
        'packages/client/ui-primitives/src/RiskConfirmation.tsx',
        'packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx',
        'packages/client/ui-workspace/src/client/WorkspacePicker.tsx',
        'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx',
        'packages/client/ui-renderer/src/client/*',
        // Session object internals retain the runtime GUI debt exemption; the
        // new Controller entry, transport, Agent scope, and adapters stay gated.
        'packages/api/session-controller/src/client/sessions/*',
        'packages/api/session-controller/src/client/ordered-baseline.ts',
        'packages/api/session-controller/src/client/time-zone.ts',
        // Keep the browser conversation tree under its existing GUI debt
        // exemption while gating the newly stateful Host half and vocabulary.
        'packages/client/ui-conversation/src/client/*',
        'packages/client/ui-conversation/src/invariant.ts',
        // Chat presentation and assembly retain the same GUI debt exemption;
        // package wiring and the new approval-detail module remain gated.
        'packages/client/ui-chat/src/client/chat/!(ApprovalCommand).{ts,tsx}',
        'packages/client/ui-chat/src/client/conversation-nodes/*',
        'packages/client/ui-chat/src/client/details/*',
        'packages/client/ui-chat/src/client/model/*',
        'packages/client/ui-chat/src/client/contract/context-provenance.ts',
        'packages/client/ui-chat/src/client/contract/snapshot.ts',
        'packages/client/ui-chat/src/client/historical-images.ts',
        'packages/client/ui-primitives/src/DisclosureRow.tsx',
        'packages/client/ui-tool/src/*',
        'packages/client/ui-slots/src/*',
        'packages/client/ui-layout/src/*',
        'packages/client/web/src/*',
        'packages/host/webserver/src/*',
        // The browser-worker runtime and its image packer: the executing
        // composition is a real dedicated Worker driven by the web browser lane
        // (apps/web/tests/preview-boot.e2e.ts), which unit-process V8 coverage
        // cannot observe. Unit specs cover the algorithmic cores; the assembled
        // evidence is that boot; a browser-grade coverage lane revisits
        // these entries.
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
        // Keep already-complete Inspector modules under the per-file gate and
        // enumerate the remaining direct-test debt instead of exempting src/**.
        // Closing these branch gaps removes the entries below.
        'packages/experimental/inspector/src/host/plugin.ts',
        'packages/experimental/inspector/src/shared/bridge/{control-codec,rpc}.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/observation.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/query/codec.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/runtime/{command-codec,console-frames,frames,value-codec}.ts',
        'packages/experimental/inspector/src/shared/bridge/messages/sources/{codec,frames}.ts',
        'packages/experimental/inspector/src/worker/inspection/{cordis-store,query-router,realm-store}.ts',
        'packages/client/modules/src/client/system.ts',
        'packages/client/hmr/src/client/index.ts',
        // Web config-tree boot round: the new host-side web-transport halves
        // whose remaining branches need real-composition/process harnesses;
        // the client test lane maturing removes these entries.
        'packages/client/modules/src/index.ts',
        'packages/client/modules/src/invariant.ts',
        'packages/client/modules/src/client/index.ts',
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
        // Slash/command/input round: per-file gaps deferred with the same
        // client-lane debt; that lane maturing removes these entries.
        'packages/client/connection/src/client/fixture.ts',
        'packages/client/ui-commands/src/index.ts',
        'packages/client/ui-skill/src/index.ts',
        'packages/client/ui-input-trigger/src/index.ts',
        'packages/client/ui-subagent/src/index.ts',
        'packages/client/ui-commands/src/client/popup.ts',
        'packages/client/ui-commands/src/client/directory.ts',
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
        'packages/client/ui-input-trigger/src/core/detect.ts',
        'packages/client/ui-sidebar/src/client/index.ts',
        'packages/client/ui-skill/src/client/index.ts',
        'packages/client/ui-workspace/src/client/index.ts',
        'packages/test-support/client-runtime/src/translate.ts',
        'packages/client/ui-primitives/src/JsonTree.tsx',
        'packages/client/ui-settings-models/src/client/DeepSeekOnboardingDialog.tsx',
        'packages/client/ui-settings-models/src/client/welcome-store.ts',
        // The Cordis extension group's per-file gaps, enumerated rather than
        // matched by a `packages/extensions/*` glob. The glob sat at the tail
        // of the client slash/command block and inherited a comment that
        // described none of it, so an entire package group left the gate
        // silently and any file added to it left too. Measured at enumeration:
        // 57.91% statements over 45 files, 12 of them already meeting every
        // threshold and now gated. Deleting an entry is how a file rejoins.
        'packages/extensions/cordis-client-runner/src/client/api-catalog.ts',
        'packages/extensions/cordis-client-runner/src/client/guard.ts',
        'packages/extensions/cordis-client-runner/src/client/index.ts',
        'packages/extensions/cordis-client-runner/src/client/inspect-registry.ts',
        'packages/extensions/cordis-client-runner/src/client/orchestrator.ts',
        'packages/extensions/cordis-client-runner/src/client/providers.ts',
        'packages/extensions/cordis-client-runner/src/client/runtime.ts',
        'packages/extensions/cordis-client-runner/src/client/timer.ts',
        'packages/extensions/cordis-host-runner/src/guard.ts',
        'packages/extensions/cordis-host-runner/src/index.ts',
        'packages/extensions/cordis-host-runner/src/inspect-registry.ts',
        'packages/extensions/cordis-host-runner/src/registry.ts',
        'packages/extensions/cordis-host-runner/src/sandbox.ts',
        'packages/extensions/cordis-host-runner/src/wire-values.ts',
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
        'packages/extensions/ui-cordis/src/client/card-model.ts',
        'packages/extensions/ui-cordis/src/client/index.ts',
        'packages/extensions/ui-cordis/src/client/inventory.ts',
        'packages/extensions/ui-cordis/src/client/locales.ts',
        'packages/extensions/ui-cordis/src/client/run-card-index.ts',
        'packages/extensions/ui-cordis/src/client/status.ts',
        'packages/extensions/ui-cordis/src/index.ts',
        'packages/extensions/ui-cordis/src/invariant.ts',
        // Typert generator: correctness is pinned by its fixture suites and
        // the byte-for-byte catalog reproduction test; per-file coverage
        // would put whole-workspace compiler analysis under v8
        // instrumentation — the coverage lane's longest tail.
        'packages/typert/generator/src/*.ts',
        // Experimental webworker-runtime is outside the coverage requirement
        // by decision: its correctness signal is its uninstrumented suite and
        // the packer's end-to-end image spec.
        'packages/experimental/webworker-runtime/src/**/*.ts',
        // Projection/command round: executor lifecycle branches and the
        // registry's drive tails need the same maturing lanes; those lanes
        // maturing removes these entries.
        'packages/interaction/commands/src/index.ts',
        'packages/interaction/commands/src/invariant.ts',
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
