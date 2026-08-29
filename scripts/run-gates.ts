/**
 * Run local and CI quality gates with bounded in-process scheduling.
 *
 * Package scripts own public aggregate names; this runner owns their validated
 * dependency graphs, scheduler environment, and process diagnostics.
 * @see ../.agents/notes/implemented/process/2026-07-06-parallel-pre-push-gates.md
 */
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CLIENT_BUILD_PROFILE_SELECTOR } from './client-build-environment.ts'
import { COVERAGE_EXEMPT_ENV, coverageExemptHeavySuites } from './coverage-exempt.ts'
import {
  COVERAGE_PARTITIONS_ENV,
  COVERAGE_TEST_TIMEOUT_ENV,
  coverageTestTimeoutArgs,
  parseCoveragePartitionCount,
} from './coverage-partitions.ts'
import { bunInvocation } from './bun-invocation.ts'

/** A named aggregate exposed by the gate runner. */
export type Mode =
  | 'ci-primary'
  | 'ci-linux-primary'
  | 'ci-static'
  | 'ci-lint-contracts-ready'
  | 'ci-coverage'
  | 'ci-snapshot'
  | 'ci-artifacts'
  | 'ci-consumers'
  | 'ci-windows-blocking'
  | 'ci-windows-complete'
  | 'ci-windows-observational'
  | 'node-compat'
  | 'check-all'
  | 'hygiene'
  | 'doc-sync'
  | 'doc-quick'

type GateResultStatus = 'passed' | 'failed' | 'skipped'
type GateState = 'pending' | 'running' | GateResultStatus

/** A command and its dependency metadata inside one aggregate. */
export interface Gate {
  id: string
  label: string
  displayCommand: string
  command: string
  args: string[]
  needs?: string[]
  /** Gate ids that must settle, regardless of outcome, before this gate starts. */
  after?: string[]
  env?: Record<string, string | undefined>
  /** Include this leaf in the build-free documentation aggregate. */
  quick?: boolean
  /** Keep a failure visible without failing the aggregate. */
  allowFailure?: boolean
  /** Write child output as it arrives instead of buffering it until completion. */
  streamOutput?: boolean
}

/** The observed outcome of one gate process. */
export interface GateResult {
  gate: Gate
  status: GateResultStatus
  durationMs: number
  output: GateOutputChunk[]
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  error?: string
}

interface GateOutputChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

interface RunningGate {
  gate: Gate
  promise: Promise<GateResult>
}

interface ConcurrencyDefault {
  workers: number
  source: string
}

type GateExecutor = (gate: Gate) => Promise<GateResult>
type ResultObserver = (result: GateResult) => void

const root = resolve(import.meta.dirname, '..')
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2))
}

async function main(args: string[]): Promise<number> {
  const mode = parseMode(args[0])
  const gates = gatesForMode(mode)
  const concurrencyDefault = defaultConcurrency(mode, gates.length)
  const concurrencyOverride = process.env.DSH_GATE_CONCURRENCY
  const maxConcurrency = concurrencyFromEnv('DSH_GATE_CONCURRENCY', concurrencyDefault.workers)
  const concurrencySource = concurrencyOverride === undefined || concurrencyOverride === ''
    ? concurrencyDefault.source
    : '$DSH_GATE_CONCURRENCY'
  const startedAt = performance.now()
  console.log(`run-gates: ${mode} running ${gates.length} gate(s) with ${maxConcurrency} worker(s) from ${concurrencySource}.`)

  const results = await runGates(gates, maxConcurrency, runGate, printResult)
  printSummary(results, performance.now() - startedAt)
  return results.some(result => result.gate.allowFailure !== true && (result.status === 'failed' || result.status === 'skipped'))
    ? 1
    : 0
}

function parseMode(raw: string | undefined): Mode {
  switch (raw) {
    case 'ci-primary':
    case 'ci-linux-primary':
    case 'ci-static':
    case 'ci-lint-contracts-ready':
    case 'ci-coverage':
    case 'ci-snapshot':
    case 'ci-artifacts':
    case 'ci-consumers':
    case 'ci-windows-blocking':
    case 'ci-windows-complete':
    case 'ci-windows-observational':
    case 'node-compat':
    case 'check-all':
    case 'hygiene':
    case 'doc-sync':
    case 'doc-quick':
      return raw
    default:
      throw new Error(
        `run-gates: expected mode ci-primary | ci-linux-primary | ci-static | ci-lint-contracts-ready | ci-coverage | ci-snapshot | ci-artifacts | ci-consumers | ci-windows-blocking | ci-windows-complete | ci-windows-observational | node-compat | check-all | hygiene | doc-sync | doc-quick, got ${JSON.stringify(raw)}.`,
      )
  }
}

/**
 * Resolve the default worker count for one aggregate.
 * @param selectedMode - aggregate whose resource posture applies.
 * @param total - number of gates in the aggregate.
 * @param available - host CPU availability for ordinary modes.
 * @returns the default worker count and its diagnostic source.
 */
export function defaultConcurrency(
  selectedMode: Mode,
  total: number,
  available = availableParallelism(),
): ConcurrencyDefault {
  if (selectedMode === 'ci-consumers') return { workers: total, source: 'ci-consumers gate count' }
  // Local modes cap workers: several doc gates each build a full ts.Program,
  // so an uncapped default on a large host trades wall clock for memory blowups.
  const localCap = selectedMode === 'check-all'
    || selectedMode === 'hygiene'
    || selectedMode === 'doc-sync'
    || selectedMode === 'doc-quick'
  const modeLimit = localCap ? Math.min(4, available) : available
  return {
    workers: Math.min(total, modeLimit),
    source: localCap
      ? `${available} available CPU(s), ${selectedMode} cap 4`
      : `${available} available CPU(s)`,
  }
}

function concurrencyFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`run-gates: ${name} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

function bunScript(id: string, script: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? script,
    displayCommand: `bun run ${script}`,
    ...bunInvocation(['run', script]),
    ...options,
  }
}

/** Build official client artifacts inside a CI aggregate without changing sibling gate environments. */
function ciBuildGate(id = 'build', options: Partial<Gate> = {}): Gate {
  return bunScript(id, 'build', {
    ...options,
    env: { ...options.env, [CLIENT_BUILD_PROFILE_SELECTOR]: 'official' },
  })
}

function bunExec(id: string, args: string[], options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: options.label ?? `bun x ${args.join(' ')}`,
    displayCommand: `bun x ${args.join(' ')}`,
    ...bunInvocation(['x', ...args]),
    ...options,
  }
}

/**
 * Construct the complete gate list for a named aggregate.
 * @param selected - aggregate mode to construct.
 * @returns the aggregate's gate graph.
 */
export function gatesForMode(selected: Mode): Gate[] {
  switch (selected) {
    case 'ci-primary':
      return ciPrimaryGates()
    case 'ci-linux-primary':
      return [...ciPrimaryGates(), webSnapshotGate(['built-package-invariants'])]
    case 'ci-static':
      return ciStaticGates({ ownsBuild: false })
    case 'ci-lint-contracts-ready':
      return [
        lintGate(),
        bunScript('duplication', 'duplication'),
      ]
    case 'ci-coverage':
      return coverageGates()
    case 'ci-snapshot':
      return [ciBuildGate(), snapshotGate()]
    case 'ci-artifacts':
      return ciArtifactGates()
    case 'ci-consumers':
      return ciConsumerGates()
    case 'ci-windows-blocking':
      return ciWindowsBlockingGates()
    case 'ci-windows-complete':
      return ciWindowsCompleteGates()
    case 'ci-windows-observational':
      return ciWindowsObservationalGates()
    case 'node-compat':
      return nodeCompatGates()
    case 'check-all':
      return [
        bunScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
        bunScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
        bunScript('client-domain-graph', 'verify-client-domain-graph', { label: 'client domain graph' }),
        bunScript('test', 'test'),
        bunScript('issue-management', 'test:issue-management', { label: 'Issue management policy' }),
        bunScript('duplication', 'duplication'),
        bunScript('mutation', 'mutation', { label: 'mutation score (util tier)' }),
        snapshotGate(),
        expectedOutputGate(),
        bunScript('build', 'build'),
        bunScript('build:web', 'build:web'),
        ...hygieneLeafGates({ artifactNeeds: ['build'] }),
        ...docSyncLeafGates({
          docTypecheckNeeds: ['build'],
          docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
          docTypecheckScript: 'doc-typecheck:contracts-ready',
        }),
        bunScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
      ]
    case 'hygiene':
      return [
        ...hygieneLeafGates(),
        bunScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
        bunScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
        bunScript('vendored-links', 'verify-vendored-links', { label: 'vendored links' }),
      ]
    case 'doc-sync':
      return docSyncLeafGates()
    case 'doc-quick':
      return docQuickLeafGates()
  }
}

function ciSharedStaticGates(): Gate[] {
  return [
    bunScript('runtime-closure', 'verify-runtime-closure', { label: 'runtime closure' }),
    bunScript('application-entrypoints', 'verify-application-entrypoints', { label: 'application entrypoints' }),
    bunScript('constraints', 'constraints'),
    bunScript('dsh-package-licenses', 'verify-dsh-package-licenses', { label: 'DSH package licenses' }),
    bunScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    bunScript('cordis-config', 'verify-cordis-config', { label: 'Cordis config' }),
    bunScript('optional-dependency-imports', 'verify-optional-dependency-imports', {
      label: 'optional dependency imports',
    }),
    bunScript('client-packages', 'verify-client-packages', { label: 'client packages' }),
    bunScript('client-ui-i18n', 'verify-client-ui-i18n', { label: 'client UI i18n' }),
    bunScript('issue-management', 'test:issue-management', { label: 'Issue management policy' }),
  ]
}

function ciPrimaryGates(): Gate[] {
  return [
    ...ciSharedStaticGates(),
    typertContractsGate(),
    bunScript('typecheck', 'typecheck:contracts-ready', { needs: ['typert-contracts'] }),
    lintGate({ needs: ['typert-contracts'] }),
    bunScript('duplication', 'duplication'),
    bunScript('mutation', 'mutation', { label: 'mutation score (util tier)' }),
    ...coverageGates(),
    ...nodeCompatSmokeGates(),
    snapshotGate(),
    ...docSyncLeafGates({
      docTypecheckNeeds: ['typert-contracts'],
      docTypecheckScript: 'doc-typecheck:contracts-ready',
    }),
    bunScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    bunScript('knip', 'knip'),
    // The prepared typecheck and build both drive Client tsc, while build also
    // repeats the Host contract pass. Wait for all three consumers so build
    // neither races tsbuildinfo nor replaces declarations while they are read.
    ciBuildGate('build', { needs: ['typecheck', 'lint', 'doc-typecheck'] }),
    bunScript('publint', 'publint', { needs: ['build'] }),
    bunScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function nodeCompatGates(): Gate[] {
  const typecheck = flagEnabled('DSH_NODE_COMPAT_SKIP_TYPECHECK')
    ? []
    : [bunScript('typecheck', 'typecheck')]
  if (runningNodeMajor() !== 22) {
    return [...typecheck, ...nodeCompatSmokeGates()]
  }
  return [
    ...typecheck,
    bunScript('build', 'build', {
      ...typecheck.length === 0 ? {} : { needs: ['typecheck'] },
    }),
    bunScript('build:web', 'build:web', {
      label: 'Web frontend build',
      needs: ['build'],
    }),
    ...nodeCompatSmokeGates({ cliSmoke: true }),
  ]
}

function nodeCompatSmokeGates(options: { cliSmoke?: boolean } = {}): Gate[] {
  const gates: Gate[] = [
    bunExec('source-worker-smoke', [
      'vitest',
      'run',
      'packages/workflow/workflow-worker-thread/tests/source-worker.compat.spec.ts',
    ], { label: 'source worker smoke' }),
    bunExec('jsonl-zstd-smoke', [
      'vitest',
      'run',
      'packages/session/session-persistence-jsonl/tests/zstd.compat.spec.ts',
    ], { label: 'JSONL Zstandard smoke' }),
    bunExec('dsh-source-launch-smoke', [
      'vitest',
      'run',
      'apps/cli/tests/source-launch.compat.spec.ts',
    ], { label: 'dsh source-launch smoke' }),
    bunExec('vitest-jsdom-smoke', [
      'vitest',
      'run',
      'scripts/vitest-environment.compat.spec.ts',
    ], { label: 'Vitest jsdom smoke' }),
  ]
  if (options.cliSmoke) {
    gates.push(
      bunExec('cli-lazy-search-startup-smoke', [
        'vitest',
        'run',
        'apps/cli/tests/lazy-search-startup.compat.spec.ts',
      ], {
        label: 'CLI lazy-search startup smoke',
        env: { DSH_REQUIRE_BUILT_CLI_SMOKE: '1' },
        needs: ['build:web'],
      }),
    )
  }
  return gates
}

/** Active Node major used to select version-specific compatibility checks. */
function runningNodeMajor(): number {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (!Number.isSafeInteger(major)) {
    throw new Error(`run-gates: cannot parse Node version ${JSON.stringify(process.versions.node)}.`)
  }
  return major
}

function ciStaticGates(options: { ownsBuild: boolean }): Gate[] {
  return [
    ...ciSharedStaticGates(),
    ...options.ownsBuild ? [ciBuildGate()] : [],
    ...docSyncLeafGates({
      includeDocTypecheck: options.ownsBuild,
      ...options.ownsBuild
        ? {
          docTypecheckNeeds: ['build'],
          docTypecheckEnv: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
          docTypecheckScript: 'doc-typecheck:contracts-ready',
        }
        : {},
      docsBuildScript: 'docs:build:mpa',
    }),
    bunScript('module-graph', 'verify-module-graph', { label: 'module graph' }),
    bunScript('knip', 'knip'),
  ]
}

function ciArtifactGates(): Gate[] {
  return [
    ciBuildGate(),
    bunScript('publint', 'publint', { needs: ['build'] }),
    bunScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
    builtBinSmokeGate(),
  ]
}

function ciConsumerGates(): Gate[] {
  const builtTree = ['build']
  const validatedBuild = ['built-package-invariants']
  // The HMR web test starts `dev:web`, which rewrites the shared `lib/` and
  // `apps/web/dist/` trees. Let every build-artifact reader settle before that
  // writer starts; `after` preserves the web diagnostic even if a reader fails.
  const buildArtifactReaders = [
    'publint',
    'lint-and-duplication',
    'snapshot',
    'expected-output',
    'doc-typecheck',
    'node-next-types',
    'built-bin-smoke',
  ]
  return [
    ciBuildGate(),
    bunScript('node-compat', 'check:node-compat', {
      label: 'Node compatibility',
      env: { [CLIENT_BUILD_PROFILE_SELECTOR]: 'official' },
    }),
    bunScript('publint', 'publint', { needs: builtTree }),
    builtPackageInvariantsGate(builtTree),
    bunScript('lint-and-duplication', 'check:ci:lint:contracts-ready', {
      label: 'lint and duplication',
      needs: validatedBuild,
    }),
    snapshotGate(validatedBuild),
    expectedOutputGate(validatedBuild),
    webSnapshotGate(validatedBuild, buildArtifactReaders),
    bunScript('doc-typecheck', 'doc-typecheck:contracts-ready', {
      needs: validatedBuild,
      env: { DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT: '1' },
    }),
    bunScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: validatedBuild,
    }),
    builtBinSmokeGate(validatedBuild),
  ]
}

function webSnapshotGate(needs: string[], after?: string[]): Gate {
  const order = after === undefined ? { needs } : { needs, after }
  const workerRaw = process.env.DSH_WEB_SNAPSHOT_WORKERS
  if (workerRaw !== undefined && workerRaw !== '') {
    const workers = Number.parseInt(workerRaw, 10)
    if (!Number.isSafeInteger(workers) || workers < 2 || String(workers) !== workerRaw) {
      throw new Error(`run-gates: DSH_WEB_SNAPSHOT_WORKERS must be an integer greater than 1, got ${JSON.stringify(workerRaw)}.`)
    }
    return bunScript('web-snapshot', 'test:web:ci', {
      label: 'web browser snapshot',
      displayCommand: `DSH_SNAPSHOT=replay DSH_WEB_SNAPSHOT_WORKERS=${workers} bun run test:web:ci`,
      env: { DSH_SNAPSHOT: 'replay' },
      ...order,
      streamOutput: true,
    })
  }
  return bunScript('web-snapshot', 'test:web:built', {
    label: 'web browser snapshot',
    displayCommand: 'DSH_SNAPSHOT=replay bun run test:web:built',
    env: { DSH_SNAPSHOT: 'replay' },
    ...order,
  })
}

function ciWindowsBlockingGates(): Gate[] {
  return [
    ciBuildGate('windows-build', { label: 'build' }),
    bunScript('windows-site', 'docs:build', { label: 'production site' }),
  ]
}

function ciWindowsCompleteGates(): Gate[] {
  const coverage = coverageGates().map(gate => ({
    ...gate,
    needs: [...new Set(['build', ...(gate.needs ?? [])])],
  }))
  const coverageAfter = coverage.map(gate => gate.id)
  const observational = ciWindowsObservationalGates()
    // The required production site replaces the observational MPA build; both
    // VitePress modes write the same output directory and cannot overlap.
    .filter(gate => gate.id !== 'build' && gate.id !== 'docs-site-build')
    .map(gate => ({
      ...gate,
      allowFailure: true,
      after: [...new Set([
        ...coverageAfter,
        ...(gate.after ?? []).map(id => id === 'docs-site-build' ? 'windows-site' : id),
      ])],
    }))
  return [
    ciBuildGate(),
    bunScript('windows-site', 'docs:build', { label: 'production site' }),
    ...coverage,
    ...observational,
  ]
}

function ciWindowsObservationalGates(): Gate[] {
  const predecessors = [
    ...ciStaticGates({ ownsBuild: true }),
    // Linux owns required lint and snapshots; Windows omits those duplicates.
    bunScript('duplication', 'duplication'),
    bunScript('publint', 'publint', { needs: ['build'] }),
    bunScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      needs: ['build'],
    }),
    builtPackageInvariantsGate(['build']),
  ]
  return [
    ...predecessors,
    {
      ...builtBinSmokeGate(),
      // This smoke starts real application children with bounded startup
      // deadlines. Let other Windows processes settle before measuring startup.
      after: predecessors.map(gate => gate.id),
    },
  ]
}

function typertContractsGate(): Gate {
  return bunScript('typert-contracts', 'build:lib:host', { label: 'Typert contracts' })
}

function lintGate(options: { needs?: string[] } = {}): Gate {
  const raw = process.env.DSH_OXLINT_THREADS
  const script = 'lint:contracts-ready'
  return bunScript('lint', script, {
    ...raw === undefined || raw === ''
      ? {}
      : { displayCommand: `DSH_OXLINT_THREADS=${raw} bun run ${script}` },
    ...options.needs === undefined ? {} : { needs: options.needs },
  })
}

// The heavy suites run uninstrumented beside the thresholded gate: their
// compiler- and subprocess-bound fixtures pay a multiple of their runtime
// under v8 instrumentation while contributing nothing the thresholds need
// (membership rules in scripts/coverage-exempt.ts).
//
// DSH_COVERAGE_MAX_WORKERS is the ordinary lane's worker budget, so the two
// parallel gates split it instead of each claiming it whole. When
// DSH_COVERAGE_PARTITIONS is set, its single-worker processes replace the
// instrumented share while this budget still sizes the exempt gate. The exempt
// gate's wall clock is dominated by its longest single file, so it takes the
// small share. A budget of 1 gives each gate 1 worker; lanes that need a strict
// total of one (the serial reference jobs) also set DSH_GATE_CONCURRENCY=1,
// which keeps the gates from overlapping at all.
// DSH_COVERAGE_TEST_TIMEOUT_MS raises Vitest's per-test and expect.poll
// defaults together for instrumented lanes whose scheduling overhead exceeds
// those defaults. Explicit fixture timeouts remain authoritative.
function coverageWorkerArgs(): { instrumented: string[]; exempt: string[] } {
  const [flag] = positiveIntArg('DSH_COVERAGE_MAX_WORKERS', '--maxWorkers')
  if (flag === undefined) return { instrumented: [], exempt: [] }
  const total = Number.parseInt(flag.split('=')[1] ?? '', 10)
  const exempt = Math.max(1, Math.floor(total / 3))
  const instrumented = Math.max(1, total - exempt)
  return {
    instrumented: [`--maxWorkers=${String(instrumented)}`],
    exempt: [`--maxWorkers=${String(exempt)}`],
  }
}

function coverageGates(): Gate[] {
  const workers = coverageWorkerArgs()
  const timeouts = coverageTestTimeoutArgs(process.env[COVERAGE_TEST_TIMEOUT_ENV])
  const partitions = parseCoveragePartitionCount(process.env[COVERAGE_PARTITIONS_ENV])
  const instrumented = partitions === undefined
    ? bunExec('coverage', [
      'vitest',
      'run',
      '--coverage',
      ...workers.instrumented,
      ...timeouts,
    ], {
      label: 'test:coverage',
      env: { [COVERAGE_EXEMPT_ENV]: '1' },
    })
    : bunScript('coverage', 'test:coverage:partitioned', {
      label: 'test:coverage',
      displayCommand: `${COVERAGE_PARTITIONS_ENV}=${partitions} bun run test:coverage:partitioned`,
      env: { [COVERAGE_EXEMPT_ENV]: '1' },
      streamOutput: true,
    })
  return [
    instrumented,
    bunExec('coverage-exempt-heavy', [
      'vitest',
      'run',
      ...coverageExemptHeavySuites.map(suite => suite.filter),
      ...workers.exempt,
      ...timeouts,
    ], {
      label: 'test:coverage-exempt-heavy',
    }),
  ]
}

// Recorded-session adapters boot process scenarios in `lib` mode. Callers wait
// either on `build` or on a validation gate that transitively owns that build.
function snapshotGate(needs: string[] = ['build']): Gate {
  return bunScript('snapshot', 'test:snapshot', {
    env: { DSH_EXAMPLE_MODE: 'lib' },
    needs,
  })
}

// Owner-local process expectations consume built package exports without entering
// the recorded-session corpus or the credentialed provider lane.
function expectedOutputGate(needs: string[] = ['build']): Gate {
  return bunScript('expected-output', 'test:expected', {
    env: { DSH_EXAMPLE_MODE: 'lib' },
    needs,
  })
}

function builtPackageInvariantsGate(needs?: string[]): Gate {
  return bunScript('built-package-invariants', 'verify-built-package-invariants', {
    label: 'built package invariants',
    ...needs === undefined ? {} : { needs },
  })
}

function positiveIntArg(envName: string, flag: string): string[] {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return []
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`run-gates: ${envName} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return [`${flag}=${raw}`]
}

function flagEnabled(envName: string): boolean {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return false
  if (raw !== '1') throw new Error(`run-gates: ${envName} must be 1 when set, got ${JSON.stringify(raw)}.`)
  return true
}

function hygieneLeafGates(options: { artifactNeeds?: string[] } = {}): Gate[] {
  const artifactOptions = options.artifactNeeds === undefined ? {} : { needs: options.artifactNeeds }
  return [
    bunScript('rescope-vendor', 'rescope-vendor:check', { label: 'vendor rescope' }),
    bunScript('knip', 'knip'),
    bunScript('publint', 'publint', artifactOptions),
    bunScript('constraints', 'constraints'),
    bunScript('application-entrypoints', 'verify-application-entrypoints', { label: 'application entrypoints' }),
    bunScript('dsh-package-licenses', 'verify-dsh-package-licenses', { label: 'DSH package licenses' }),
    bunScript('package-invariants', 'verify-package-invariants', { label: 'package invariants' }),
    builtPackageInvariantsGate(options.artifactNeeds),
    bunScript('node-next-types', 'verify-node-next-types', {
      label: 'node-next types',
      ...artifactOptions,
    }),
    bunScript('optional-dependency-imports', 'verify-optional-dependency-imports', {
      label: 'optional dependency imports',
    }),
    bunScript('client-packages', 'verify-client-packages', { label: 'client packages' }),
    bunScript('client-ui-i18n', 'verify-client-ui-i18n', { label: 'client UI i18n' }),
  ]
}

function docSyncLeafGates(options: {
  includeDocTypecheck?: boolean
  docTypecheckNeeds?: string[]
  docTypecheckEnv?: Record<string, string | undefined>
  docTypecheckScript?: 'doc-typecheck' | 'doc-typecheck:contracts-ready'
  docsBuildScript?: 'docs:build' | 'docs:build:mpa'
} = {}): Gate[] {
  const docTypecheckOptions: Partial<Gate> = {}
  if (options.docTypecheckNeeds !== undefined) docTypecheckOptions.needs = options.docTypecheckNeeds
  if (options.docTypecheckEnv !== undefined) docTypecheckOptions.env = options.docTypecheckEnv
  return [
    // Stable FIFO starts the longest leaves first; only docs-site-build writes website/.generated.
    ...options.includeDocTypecheck === false
      ? []
      : [bunScript('doc-typecheck', options.docTypecheckScript ?? 'doc-typecheck', docTypecheckOptions)],
    bunScript('docs-site-build', options.docsBuildScript ?? 'docs:build', { label: 'documentation build' }),
    bunScript('doc-graphs', 'verify-doc-graphs', { label: 'doc graphs' }),
    bunScript('markdown-links', 'verify-md-links', { label: 'markdown links', quick: true }),
    bunScript('type-equivalence', 'verify-type-equiv', { label: 'type equivalence', quick: true }),
    bunScript('cordis-catalog', 'verify-cordis-catalog', { label: 'cordis catalog' }),
    bunScript('cordis-inspect-catalog', 'verify-cordis-inspect-catalog', { label: 'Cordis inspect catalog' }),
    bunScript('mermaid', 'verify-mermaid'),
    bunScript('scoped-events', 'verify-scoped-events', { label: 'scoped events' }),
    bunScript('translation-pairing', 'verify-translation-pairing', { label: 'translation pairing', quick: true }),
    bunScript('markdown-wrap', 'verify-md-wrap', { label: 'markdown wrap', quick: true }),
    bunScript('client-catalog', 'verify-client-catalog', { label: 'client catalog' }),
    bunScript('export-jsdoc', 'verify-export-jsdoc', { label: 'export jsdoc' }),
    bunScript('tool-catalog', 'verify-tool-catalog', { label: 'tool catalog' }),
    bunScript('config-catalog', 'verify-config-catalog', { label: 'config catalog' }),
    bunScript('persistence-catalog', 'verify-persistence-catalog', { label: 'persistence catalog' }),
    bunScript('public-repository-links', 'verify-public-repository-links', { label: 'public repository links', quick: true }),
    bunScript('doc-refs', 'verify-doc-refs', { label: 'doc refs', quick: true }),
    bunScript('subsystem-pages', 'verify-subsystem-pages', { label: 'subsystem pages' }),
    bunScript('package-paths', 'verify-package-paths', { label: 'package paths' }),
    bunScript('tsconfig-paths', 'verify-tsconfig-paths', { label: 'tsconfig paths' }),
    bunScript('config-source-ownership', 'verify-config-source-ownership', { label: 'config source ownership' }),
    bunScript('package-readme-model-experience', 'verify-package-readme-model-experience', { label: 'package README model experience', quick: true }),
    bunScript('agent-note-classification', 'verify-agent-note-classification', { label: 'agent note classification', quick: true }),
    bunScript('agent-note-format', 'verify-agent-note-format', { label: 'agent note format', quick: true }),
    bunScript('archived-agent-notes', 'verify-archived-agent-notes', { label: 'archived agent notes', quick: true }),
    bunScript('skill-invocation-metadata', 'verify-skill-invocation-metadata', { label: 'skill invocation metadata', quick: true }),
    bunScript('translation-prompt', 'verify-translation-prompt', { label: 'translation prompt', quick: true }),
    bunScript('doc-budgets', 'verify-doc-budgets', { label: 'doc budgets', quick: true }),
    bunExec('doc-standard-tests', ['vitest', 'run', 'scripts/doc-standard.spec.ts'], {
      label: 'documentation standard tests',
      quick: true,
    }),
    bunExec('docs-site-projection', ['vitest', 'run', 'scripts/project-doc-site.spec.ts', 'scripts/verify-doc-site-fragments.spec.ts'], {
      label: 'documentation site checks',
    }),
    bunScript('package-readme-limitations', 'verify-package-readme-limitations', { label: 'package README limitations', quick: true }),
  ]
}

/**
 * The quick comprehensive documentation-standard aggregate for `test:docs`.
 * It covers the prose, pairing, README, budget, and Agent Note gates
 * without builds, generator regeneration, or the VitePress site build.
 */
function docQuickLeafGates(): Gate[] {
  return docSyncLeafGates({ includeDocTypecheck: false }).filter(gate => gate.quick === true)
}

function builtBinSmokeGate(needs: string[] = ['build']): Gate {
  return bunExec('built-bin-smoke', [
    'vitest',
    'run',
    '--config',
    'vitest.e2e.config.ts',
    'apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts',
    'apps/cli/tests/built-bin.e2e.ts',
    'packages/host/directory-picker-native/tests/built-worker.e2e.ts',
    'packages/sdk/server/tests/built-scope-carrier.e2e.ts',
    'packages/subagent/subagent-codex/tests/loader-composition.e2e.ts',
    'packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts',
    'packages/api/remotes/tests/built-lib.e2e.ts',
    'packages/experimental/agent-team/tests/built-lib.e2e.ts',
    // Built execution consumers: the only automated proof that package-name
    // imports reach their lib/ entrypoints under plain Node. The e2e lane runs
    // unbuilt, so these files self-skip there.
    'packages/workflow/workflow-worker-thread/tests/built-worker.e2e.ts',
    'packages/code-runtime/code-runtime-worker-thread/tests/built-lib.e2e.ts',
    'packages/lsp/lsp-stdio/tests/built-lib.e2e.ts',
  ], {
    label: 'built-bin smoke',
    needs,
    env: { DSH_EXAMPLE_MODE: 'lib' },
  })
}

/**
 * Reject a gate list whose graph cannot be executed unambiguously.
 * @param gates - complete aggregate to validate.
 */
function validateGateGraph(gates: readonly Gate[]): void {
  if (gates.length === 0) throw new Error('run-gates: gate graph has no gates.')

  const ids = new Set<string>()
  for (const gate of gates) {
    if (ids.has(gate.id)) throw new Error(`run-gates: duplicate gate id ${JSON.stringify(gate.id)}.`)
    ids.add(gate.id)
  }
  for (const gate of gates) {
    for (const dependency of gate.needs ?? []) {
      if (!ids.has(dependency)) {
        throw new Error(`run-gates: gate ${JSON.stringify(gate.id)} depends on unknown gate ${JSON.stringify(dependency)}.`)
      }
    }
    for (const predecessor of gate.after ?? []) {
      if (!ids.has(predecessor)) {
        throw new Error(`run-gates: gate ${JSON.stringify(gate.id)} waits for unknown gate ${JSON.stringify(predecessor)}.`)
      }
    }
  }

  const cycle = findDependencyCycle(gates)
  if (cycle !== undefined) throw new Error(`run-gates: dependency cycle: ${cycle.join(' -> ')}.`)
}

function findDependencyCycle(gates: readonly Gate[]): string[] | undefined {
  const byId = new Map(gates.map(gate => [gate.id, gate]))
  const complete = new Set<string>()
  const active = new Map<string, number>()
  const path: string[] = []

  const visit = (id: string): string[] | undefined => {
    if (complete.has(id)) return undefined
    const cycleStart = active.get(id)
    if (cycleStart !== undefined) return [...path.slice(cycleStart), id]
    const gate = byId.get(id)
    if (gate === undefined) return undefined

    active.set(id, path.length)
    path.push(id)
    for (const predecessor of [...(gate.needs ?? []), ...(gate.after ?? [])]) {
      const cycle = visit(predecessor)
      if (cycle !== undefined) return cycle
    }
    path.pop()
    active.delete(id)
    complete.add(id)
    return undefined
  }

  for (const gate of gates) {
    const cycle = visit(gate.id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/**
 * Validate and run one aggregate before the injected executor can start a child.
 * @param gates - complete aggregate to execute.
 * @param maxActive - maximum concurrent child count.
 * @param execute - child-process executor.
 * @param observe - result observer invoked when each gate settles.
 * @returns results in aggregate order.
 */
export async function runGates(
  gates: Gate[],
  maxActive: number,
  execute: GateExecutor,
  observe: ResultObserver = () => {},
): Promise<GateResult[]> {
  validateGateGraph(gates)
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new Error(`run-gates: max concurrency must be a positive integer, got ${JSON.stringify(maxActive)}.`)
  }
  const states = new Map<string, GateState>(gates.map(gate => [gate.id, 'pending']))
  const results = new Map<string, GateResult>()
  const running: RunningGate[] = []

  for (;;) {
    let madeProgress = false
    while (running.length < maxActive) {
      const ready = gates.find(gate => states.get(gate.id) === 'pending' && predecessorsReady(gate, states))
      if (ready === undefined) break
      states.set(ready.id, 'running')
      running.push({ gate: ready, promise: execute(ready) })
      console.log(`run-gates: start ${ready.label}`)
      madeProgress = true
    }

    if (running.length === 0) {
      const pending = gates.filter(gate => states.get(gate.id) === 'pending')
      if (pending.length === 0) break
      const gate = pending.find(item => (item.needs ?? []).some(id => gateFailed(states.get(id))))
      if (gate === undefined) throw new Error('run-gates: validated graph stalled without a failed dependency.')
      const failedDeps = (gate.needs ?? []).filter(id => gateFailed(states.get(id)))
      const result: GateResult = {
        gate,
        status: 'skipped',
        durationMs: 0,
        output: [],
        exitCode: null,
        signalCode: null,
        error: `dependency failed or skipped: ${failedDeps.join(', ')}`,
      }
      states.set(gate.id, 'skipped')
      results.set(gate.id, result)
      observe(result)
      continue
    }

    if (!madeProgress) {
      const settled = await Promise.race(running.map(async item => ({ item, result: await item.promise })))
      running.splice(running.indexOf(settled.item), 1)
      states.set(settled.item.gate.id, settled.result.status)
      results.set(settled.item.gate.id, settled.result)
      observe(settled.result)
    }
  }

  return gates.map((gate) => {
    const result = results.get(gate.id)
    if (result === undefined) throw new Error(`run-gates: missing result for ${gate.id}.`)
    return result
  })
}

function predecessorsReady(gate: Gate, states: Map<string, GateState>): boolean {
  return (gate.needs ?? []).every(id => states.get(id) === 'passed')
    && (gate.after ?? []).every(id => gateSettled(states.get(id)))
}

function gateSettled(state: GateState | undefined): boolean {
  return state === 'passed' || state === 'failed' || state === 'skipped'
}

function gateFailed(state: GateState | undefined): boolean {
  return state === 'failed' || state === 'skipped'
}

/**
 * Execute one gate through the real shell-free child-process boundary.
 * @param gate - command and scheduler environment to execute.
 * @returns the complete process outcome.
 */
export async function runGate(gate: Gate): Promise<GateResult> {
  const started = performance.now()
  const output: GateOutputChunk[] = []
  let spawnError: string | undefined

  const outcome = await new Promise<{
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }>((resolveExit) => {
    const child = spawn(gate.command, gate.args, {
      cwd: root,
      env: { ...process.env, ...gate.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (gate.streamOutput === true) process.stdout.write(chunk)
      else output.push({ stream: 'stdout', text: chunk })
    })
    child.stderr.on('data', (chunk: string) => {
      if (gate.streamOutput === true) process.stderr.write(chunk)
      else output.push({ stream: 'stderr', text: chunk })
    })
    child.on('error', (error) => {
      spawnError = `failed to start command: ${error.message}`
      resolveExit({ exitCode: null, signalCode: null })
    })
    child.on('close', (exitCode, signalCode) => {
      resolveExit({ exitCode, signalCode })
    })
    child.stdin.end()
  })
  const { exitCode, signalCode } = outcome

  const status: GateResultStatus = exitCode === 0 && signalCode === null && spawnError === undefined ? 'passed' : 'failed'
  const result: GateResult = {
    gate,
    status,
    durationMs: performance.now() - started,
    output,
    exitCode,
    signalCode,
  }
  if (spawnError !== undefined) result.error = spawnError
  return result
}

/**
 * Format every independently observed failure fact for the aggregate summary.
 * @param result - unsuccessful gate result.
 * @returns error, exit, and signal facts without allowing one to hide another.
 */
export function formatGateResultReason(result: GateResult): string {
  const facts: string[] = []
  if (result.error !== undefined) facts.push(result.error)
  if (result.exitCode !== null) facts.push(`exit ${result.exitCode}`)
  if (result.signalCode !== null) facts.push(`signal ${result.signalCode}`)
  return facts.length === 0 ? 'no exit code or signal' : facts.join(', ')
}

function printResult(result: GateResult): void {
  const verbose = process.env.DSH_GATE_VERBOSE === '1'
  const seconds = (result.durationMs / 1000).toFixed(2)
  if (result.status === 'passed' && !verbose) {
    console.log(`run-gates: PASS ${result.gate.label} (${seconds}s)`)
    return
  }

  const heading = `${result.status.toUpperCase()} ${result.gate.label} (${seconds}s)`
  const writeHeading = result.status === 'passed' ? console.log : console.error
  writeHeading(`\n== ${heading} ==`)
  if (result.status !== 'passed') {
    console.error(`command: ${result.gate.displayCommand}`)
    console.error(`outcome: ${formatGateResultReason(result)}`)
  }
  if (result.gate.streamOutput !== true) printOutput(result.output)
}

function printSummary(results: GateResult[], durationMs: number): void {
  const passed = results.filter(result => result.status === 'passed').length
  const failed = results.filter(result => result.status === 'failed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const seconds = (durationMs / 1000).toFixed(2)
  console.log(`\nrun-gates: ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s.`)

  const unsuccessful = results.filter(result => result.status === 'failed' || result.status === 'skipped')
  if (unsuccessful.length === 0) return

  console.error('run-gates: unsuccessful gates:')
  for (const result of unsuccessful) {
    const duration = (result.durationMs / 1000).toFixed(2)
    const reason = formatGateResultReason(result)
    const disposition = result.gate.allowFailure === true ? 'NON-BLOCKING ' : ''
    console.error(`  - ${disposition}${result.status.toUpperCase()} ${result.gate.label} (${duration}s, ${reason})`)
    console.error(`    ${result.gate.displayCommand}`)
  }
}

function printOutput(output: GateOutputChunk[]): void {
  for (const chunk of output) {
    if (chunk.stream === 'stdout') process.stdout.write(chunk.text)
    else process.stderr.write(chunk.text)
  }
}
