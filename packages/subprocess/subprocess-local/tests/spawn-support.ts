import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSubprocess } from '../src/spawn.ts'
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/**
 * Translate the suite's POSIX command strings into node one-liners on Windows,
 * where no bash exists; the translated commands keep the same observable
 * stdout/stderr/exit-code contract the bash originals pin on POSIX.
 * @param command - the bash `-c` command string used by the test.
 * @returns the argv to spawn.
 */
function shellArgv(command: string): string[] {
  if (process.platform !== 'win32') return ['bash', '-c', command]
  const node = (script: string): string[] => [process.execPath, '-e', script]
  switch (command) {
    case 'true': return node('')
    case 'echo hello': return node('console.log("hello")')
    case 'echo hi': return node('console.log("hi")')
    case 'echo oops >&2': return node('console.error("oops")')
    case 'echo err >&2': return node('console.error("err")')
    case 'echo out; echo err >&2': return node('console.log("out"); console.error("err")')
    case 'echo out; echo to-parent >&2': return node('console.log("out"); console.error("to-parent")')
    case 'echo to-parent; echo err >&2': return node('console.log("to-parent"); console.error("err")')
    case 'exit 42': return node('process.exit(42)')
    case 'exit 7': return node('process.exit(7)')
    case 'pwd': return node('console.log(process.cwd())')
    case 'sleep 60': return node('setTimeout(() => {}, 60000)')
    case 'exec sleep 60': return node('setTimeout(() => {}, 60000)')
    case 'cat': return node('process.stdin.pipe(process.stdout)')
    case 'unused': return node('')
    case 'echo "${TERM:-unset}"': return node('console.log(process.env.TERM ?? "unset")')
    case 'echo "$EXTRA_ONE/$EXTRA_TWO"': return node('console.log(process.env.EXTRA_ONE + "/" + process.env.EXTRA_TWO)')
    case 'echo "$EXPLICIT_OVERRIDE_PASSWORD"': return node('console.log(process.env.EXPLICIT_OVERRIDE_PASSWORD)')
    case 'echo "${SUBPROCESS_TOMBSTONE_PROBE:-absent}"': return node('console.log(process.env.SUBPROCESS_TOMBSTONE_PROBE ?? "absent")')
    case 'echo "[${DSH_STALE:-absent}|$DSH_SHELL|$DSH_SESSION_ID]"':
      return node('console.log("[" + [process.env.DSH_STALE ?? "absent", process.env.DSH_SHELL, process.env.DSH_SESSION_ID].join("|") + "]")')
    case 'echo "[${DSH_TEST_API_KEY:-absent}|${DSH_TEST_TOKEN:-absent}|${SUBPROCESS_TEST_PASSWORD:-absent}|${DSH_TEST_PLAIN:-absent}]"':
      return node('console.log("[" + [process.env.DSH_TEST_API_KEY ?? "absent", process.env.DSH_TEST_TOKEN ?? "absent", process.env.SUBPROCESS_TEST_PASSWORD ?? "absent", process.env.DSH_TEST_PLAIN ?? "absent"].join("|") + "]")')
    case 'printf "%.0sx" $(seq 1 500)': return node('process.stdout.write("x".repeat(500))')
    case 'printf "%.0sx" $(seq 1 500); printf "%.0se" $(seq 1 500) >&2':
      return node('process.stdout.write("x".repeat(500)); process.stderr.write("e".repeat(500))')
    case 'for i in $(seq 1 200); do printf "line-%04d\\n" $i; done':
      return node('for (let i = 1; i <= 200; i++) console.log("line-" + String(i).padStart(4, "0"))')
    default:
      throw new Error(`spawn.spec: no win32 node translation for ${JSON.stringify(command)}`)
  }
}

/**
 * Kill the process a win32-injected taskkill mock targets, tolerating one that
 * already exited the way taskkill tolerates a not-found tree. Node's own signal
 * delivery is the primitive here: a `kill` binary exists on POSIX only, so a
 * spawned one would silently terminate nothing on the win32 lane.
 * @param pid - process id the simulated taskkill targets.
 */
export function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Swallows only the already-exited case: nothing else can reach a pid this
    // suite spawned and owns.
  }
}

export const spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-spec-'))

type SpecOverrides = Partial<Parameters<typeof spawnSubprocess>[0]> & {
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  maxSpillBytes?: number
  stdin?: string
}

export function spec(command: string, overrides: SpecOverrides = {}) {
  const { stdoutMaxBytes = 64_000, stderrMaxBytes = 64_000, maxSpillBytes = 64 * 1024 * 1024, stdin, ...rest } = overrides
  return {
    argv: shellArgv(command),
    cwd: process.cwd(),
    stdio: {
      stdin: stdin !== undefined ? { data: stdin } : 'ignore' as const,
      stdout: { maxBytes: stdoutMaxBytes, spill: { maxBytes: maxSpillBytes } },
      stderr: { maxBytes: stderrMaxBytes, spill: { maxBytes: maxSpillBytes } },
    },
    graceMs: 3_000,
    ...rest,
  }
}

/**
 * Whether the pid still exists. The zero signal is an existence probe on every
 * supported host, including Windows; EPERM means the process is there but not
 * ours to signal, which is still alive.
 * @param pid - the process to probe.
 * @returns whether the process table still holds the pid.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Linux-only /proc check: the state char is zombie (Z) or dead (X), or the entry vanished. */
function zombieOrGone(pid: number): boolean {
  const statPath = `/proc/${pid}/stat`
  if (!existsSync(statPath)) return true
  const stat = readFileSync(statPath, 'utf8')
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
  return state === 'Z' || state === 'X'
}

/** Poll until a pid no longer exists, or is only a zombie on Linux. */
export async function waitGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    if (process.platform === 'linux' && zombieOrGone(pid)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`)
}

export async function waitForStdout(running: SubprocessHandle, expected: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (running.collected.stdout!.readFrom(0).text.includes(expected)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`stdout did not include ${JSON.stringify(expected)} after ${timeoutMs}ms`)
}

/** Await settlement and project both collected streams like a batch outcome. */
export async function finish(running: SubprocessHandle) {
  const outcome = await running.done
  const final = (reader: SubprocessOutputReader | undefined) => {
    const read = reader!.readFrom(0)
    return { text: read.text, truncated: read.lossy, ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {} }
  }
  return { ...outcome, stdout: final(running.collected.stdout), stderr: final(running.collected.stderr) }
}

export async function waitForPidFile(path: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid file ${path} was not written after ${timeoutMs}ms`)
}
