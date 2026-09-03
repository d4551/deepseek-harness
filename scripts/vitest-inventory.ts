/**
 * Test-selection inventory for the root vitest.config.ts: the pure package and
 * suite lists that decide which specs run in which lane. Platform probes and
 * coverage composition stay in vitest.config.ts, which imports these lists.
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
export const windowsUnsupportedPackages = process.platform === 'win32'
  ? [
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
  : []

// These suites compare against or assemble the Worker's fixed Linux platform.
// Host-native Windows and macOS behavior is not their oracle.
const nonLinuxWebWorkerTests = process.platform === 'linux'
  ? []
  : [
    'packages/experimental/webworker-runtime/tests/node/fs-watch-stream.spec.ts',
    'packages/experimental/webworker-runtime/tests/node/sandbox-stack.spec.ts',
  ]

/** Webworker suites excluded off-Linux because their oracle is the fixed Worker platform. */
export const nonLinuxTests: readonly string[] = nonLinuxWebWorkerTests

// The merged shell tool package hosts both dialects, so the win32 exclusion is
// per suite rather than per package: its bash suites drive a real `bash -c`
// executor Windows has no interpreter for, while its pwsh suites are exactly
// what the win32 lane exists to exercise.
const windowsUnsupportedShellToolSuites = process.platform === 'win32'
  ? [
    'packages/shell/tool-shell/tests/bash-dialect.spec.ts',
    'packages/shell/tool-shell/tests/bash-integration.spec.ts',
  ]
  : []

/** Windows packages whose whole suite set stays out of the win32 lane, plus the per-suite entries. */
export const windowsPackageTestExclusions: readonly string[] = [
  ...windowsUnsupportedPackages.map(path => `${path}/tests/**/*.spec.ts`),
  ...windowsUnsupportedShellToolSuites,
]

// These suites exercise process-global state, process APIs, or timing-sensitive
// process I/O that worker threads cannot isolate reliably under aggregate gate
// contention. Keep the narrow exception in forks while the rest of the
// inventory avoids per-file processes.
export const processBoundTests = [
  'packages/session/session-persistence-jsonl/tests/jsonl.spec.ts',
  'packages/subagent/subagent-acp/tests/subagent-acp.spec.ts',
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
