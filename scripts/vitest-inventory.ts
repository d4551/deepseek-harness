/**
 * Test-selection inventory for the root vitest.config.ts: the pure package
 * and suite lists that decide which specs run in which lane, and the source
 * globs the coverage gate drops where a host cannot execute them. Every list
 * is declared unconditionally so `scripts/coverage-debt.ts` reads it back on
 * any platform and fails on an entry naming nothing in the tree; the platform
 * selection happens in the derived exports at the bottom, and vitest.config.ts
 * owns the host probes and the coverage composition.
 */

// Every entry states the concrete Windows fact that keeps it out. A bare path
// here would hide a package that is merely UNTESTED on Windows behind one that
// genuinely cannot run there, which is how the hooks integration and the pwsh
// PTY dialect went unexercised. The pwsh-requiring suites (pwsh-local,
// tool-shell's pwsh dialect, terminal-bash's pwsh dialect, hook-protocol's
// pwsh shell) deliberately stay INCLUDED: PowerShell ships with Windows, so
// they run natively here. This explicit list (not a 'packages/shell/*' glob)
// keeps packages/shell/shell — the Service Definition package — running on
// Windows.
/** Packages whose whole suite set cannot run on win32. */
const WINDOWS_UNSUPPORTED_PACKAGES: readonly string[] = [
  // The POSIX bash executor itself: its subject is `bash -c`, which
  // Windows has no interpreter for. Its Windows peer is pwsh-local.
  'packages/shell/bash-local',
  // The bash executor under a POSIX sandbox runner (bwrap/Landlock/
  // Seatbelt); the Windows confinement peer is packages/shell/pwsh-sandbox.
  'packages/shell/bash-sandbox',
  // Runner selection for the POSIX chain: the suites stage bwrap,
  // Landlock, and sandbox-exec through real POSIX shell scripts. The
  // win32 rung's argv, dialect, and probe are asserted platform-
  // independently in sandbox-windows-acl/tests/provider-chain.spec.ts, and
  // its real confinement in the win32-only suites that job runs.
  'packages/sandbox/sandbox-local',
]

// The merged shell tool package hosts both dialects, so the win32 exclusion is
// per suite rather than per package: its bash suites drive a real `bash -c`
// executor Windows has no interpreter for, while its pwsh suites are exactly
// what the win32 lane exists to exercise.
/** tool-shell suites that drive a real `bash -c` executor. */
const WINDOWS_UNSUPPORTED_SHELL_TOOL_SUITES: readonly string[] = [
  'packages/shell/tool-shell/tests/bash-dialect.spec.ts',
  'packages/shell/tool-shell/tests/bash-integration.spec.ts',
]

// Win32 facts beyond the package list: these suites' oracle is the host's own
// POSIX semantics or the fixed-linux worker face, so Windows cannot host them.
/** Webworker suites whose oracle Windows cannot supply. */
const WINDOWS_UNSUPPORTED_WEBWORKER_SUITES: readonly string[] = [
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

// These suites compare against or assemble the Worker's fixed Linux platform.
// Host-native Windows and macOS behavior is not their oracle.
/** Webworker suites that run on Linux only. */
const NON_LINUX_WEBWORKER_SUITES: readonly string[] = [
  'packages/experimental/webworker-runtime/tests/node/fs-watch-stream.spec.ts',
  'packages/experimental/webworker-runtime/tests/node/sandbox-stack.spec.ts',
]

// Windows-only packages: their sources execute exclusively on win32 (koffi
// loads Win32 libraries), so the Linux coverage lane can never cover them.
// The Windows dev/CI lane exercises them through the probe/runner suites; the
// per-file 100% gate must not fail on their Linux-uncovered paths.
/** Sources the coverage gate drops off win32. */
export const WINDOWS_ONLY_COVERAGE_SOURCES: readonly string[] = ['packages/sandbox/sandbox-windows-acl/src/**/*.ts']

// The confinement runner entry executes exclusively as a spawned child
// process (the sandbox seam prefixes child argv with this entry): its
// module-level main() would run the confinement in-process if imported, and
// vitest's v8 coverage never measures child processes. Its behavior is pinned
// end-to-end by tests/runner.spec.ts, which spawns the real entry through tsx.
/** The runner entry the win32 coverage lane drops. */
export const WINDOWS_RUNNER_COVERAGE_SOURCES: readonly string[] = ['packages/sandbox/sandbox-windows-acl/src/runner.ts']

// pwsh-local's run/start/lifecycle suites self-skip without a real pwsh
// (executor.spec.ts hasPwsh), leaving these files far below per-file 100% on
// pwsh-less hosts; the exemption keeps those hosts green while CI runners
// ship pwsh and still enforce the full bar.
/** Sources the coverage gate drops on a host without pwsh. */
export const PWSH_COVERAGE_SOURCES: readonly string[] = [
  'packages/shell/pwsh-local/src/index.ts',
  'packages/shell/pwsh-sandbox/src/**/*.ts',
]

/** Coverage sources some host or platform drops; none of them is debt, so a measurement drops them all. */
export const CONDITIONAL_COVERAGE_SOURCES: readonly string[] = [
  ...WINDOWS_UNSUPPORTED_PACKAGES.map(pkg => `${pkg}/src/**/*.ts`),
  ...WINDOWS_ONLY_COVERAGE_SOURCES,
  ...WINDOWS_RUNNER_COVERAGE_SOURCES,
  ...PWSH_COVERAGE_SOURCES,
]

/** Every conditional lane entry, suites and coverage sources alike, for the staleness check. */
export const CONDITIONAL_LANE_ENTRIES: readonly string[] = [
  ...WINDOWS_UNSUPPORTED_PACKAGES.map(pkg => `${pkg}/tests/**/*.spec.ts`),
  ...WINDOWS_UNSUPPORTED_SHELL_TOOL_SUITES,
  ...WINDOWS_UNSUPPORTED_WEBWORKER_SUITES,
  ...NON_LINUX_WEBWORKER_SUITES,
  ...CONDITIONAL_COVERAGE_SOURCES,
]

/** The win32-unsupported packages, on win32 only. */
export const windowsUnsupportedPackages: readonly string[] = process.platform === 'win32'
  ? WINDOWS_UNSUPPORTED_PACKAGES
  : []

/** Webworker suites excluded off-Linux because their oracle is the fixed Worker platform. */
export const nonLinuxTests: readonly string[] = process.platform === 'linux' ? [] : NON_LINUX_WEBWORKER_SUITES

/** Every suite the win32 lane leaves out: whole packages plus the per-suite entries. */
export const windowsTestExclusions: readonly string[] = process.platform === 'win32'
  ? [
    ...WINDOWS_UNSUPPORTED_PACKAGES.map(path => `${path}/tests/**/*.spec.ts`),
    ...WINDOWS_UNSUPPORTED_SHELL_TOOL_SUITES,
    ...WINDOWS_UNSUPPORTED_WEBWORKER_SUITES,
  ]
  : []

// These suites exercise process-global state, process APIs, or timing-sensitive
// process I/O that worker threads cannot isolate reliably under aggregate gate
// contention. Keep the narrow exception in forks while the rest of the
// inventory avoids per-file processes.
export const processBoundTests = [
  'packages/session/session-persistence-jsonl/tests/jsonl.spec.ts',
  'packages/subagent/subagent-acp/tests/subagent-acp.spec.ts',
  'packages/subagent/subagent-codex/tests/real-product.spec.ts',
  'packages/subprocess/subprocess-local/tests/process-exit.spec.ts',
  'packages/subprocess/subprocess-local/tests/spawn.spec.ts',
  'packages/subprocess/subprocess-local/tests/spawn-env.spec.ts',
  'packages/subprocess/subprocess-local/tests/spawn-output.spec.ts',
  'packages/subprocess/subprocess-local/tests/spawn-tree.spec.ts',
  'packages/context/time-context/tests/time-context.spec.ts',
  'packages/boot/app-boot/tests/app-boot.spec.ts',
  'packages/workflow/workflow-worker-thread/tests/session.spec.ts',
  // Real shells, process trees, and repository git state: each drives a live
  // bash session or subprocess tree against a per-command budget, so two of
  // them in flight at once exhaust the budget rather than the work.
  'packages/boot/app-boot/tests/user-patches.spec.ts',
  'packages/shell/tool-shell-persistent/tests/bash-loader-composition.spec.ts',
  'packages/terminal/terminal-bash/tests/local.spec.ts',
  'scripts/client-build-environment.client.spec.ts',
  // Repository-global git state: the installer rewrites the real hook path and
  // its include chain, which no two workers can hold at once.
  'scripts/install-lefthook.spec.ts',
  // Filesystem watchers and disposal ordering: both assert what happened
  // inside a timing window, which a loaded fork pool widens past the assertion.
  'packages/boot/app-boot/tests/hmr-config.spec.ts',
  'packages/session/session-projection-cache/tests/cache.spec.ts',
  // A real dedicated Worker with its own inspector sessions: the realm and
  // console round trips are timing-sensitive process I/O, and a loaded fork
  // pool widens them past the assertion in whichever test lost the race.
  'packages/experimental/inspector/tests/integration.host.spec.ts',
]
