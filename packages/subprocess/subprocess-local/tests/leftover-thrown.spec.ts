import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '../src/index.ts'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

const LEFTOVERS: Thrown[] = [
  { tag: 'leftover-object' },
  'leftover string',
  0,
  false,
  1n,
  Symbol.for('leftover-subprocess-local'),
  null,
  undefined,
]

const leftoverUnhandled: Thrown[] = []

function recordLeftoverUnhandled(reason: Thrown): void {
  leftoverUnhandled.push(reason)
}

beforeEach(() => {
  leftoverUnhandled.length = 0
  process.on('unhandledRejection', recordLeftoverUnhandled)
})

afterEach(() => {
  process.off('unhandledRejection', recordLeftoverUnhandled)
})

function leftoverExitSpec(): SubprocessSpawnSpec {
  return {
    argv: [process.execPath, '-e', ''],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } },
      stderr: { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } },
    },
    graceMs: 200,
  }
}

/**
 * Read one runtime-owned set through the claim boundary.
 * @param target - the service that holds the set.
 * @param key - the own-property name.
 * @returns the set.
 */
function ownSet(target: object, key: string): Set<object> {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor === undefined) throw new Error(`${key} is missing`)
  const holder: { value?: unknown } = {}
  Object.defineProperty(holder, 'value', descriptor)
  const value = holder.value
  if (!(value instanceof Set)) throw new Error(`${key} is not a set`)
  return value
}

/**
 * Read one runtime-owned method through the claim boundary.
 * @param target - the service that holds the method.
 * @param key - the own-property or prototype-property name.
 * @returns the method.
 */
function ownMethod(target: object, key: string): (this: object) => Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), key)
  if (descriptor === undefined) throw new Error(`${key} is missing`)
  const holder: { value?: unknown } = {}
  Object.defineProperty(holder, 'value', descriptor)
  const value = holder.value
  if (typeof value !== 'function') throw new Error(`${key} is not a function`)
  return function leftoverOwnedMethod(this: object): Promise<void> {
    const result: unknown = Reflect.apply(value, this, [])
    if (result instanceof Promise) return result.then(() => undefined)
    throw new Error(`${key} did not return a Promise`)
  }
}

function disposeManaged(service: object): Promise<void> {
  return ownMethod(service, 'disposeManagedProcesses').call(service)
}

describe('leftover Promise reject arms', () => {
  it('claims leftover waitForExit refuses after spawn settlement', async () => {
    for (const leftover of LEFTOVERS) {
      const ctx = new Context()
      const fiber = await ctx.plugin(LocalSubprocessRuntime)
      const handle = ctx.subprocess.spawn(leftoverExitSpec())
      handle.waitForExit = () => Promise.reject(leftover)
      await handle.done
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      await expect(disposeManaged(ctx.subprocess)).rejects.toBe(leftover)
      leftoverUnhandled.length = 0
      await fiber.dispose()
    }
  })

  it('contains leftover done refuses during disposal', async () => {
    for (const leftover of LEFTOVERS) {
      const ctx = new Context()
      const fiber = await ctx.plugin(LocalSubprocessRuntime)
      const leftoverDone = Promise.reject(leftover)
      leftoverDone.catch((_error: Thrown) => undefined)
      let terminateCalls = 0
      let hostExitCalls = 0
      ownSet(ctx.subprocess, 'live').add({
        done: leftoverDone,
        terminate: () => { terminateCalls += 1 },
        terminateForHostExit: () => { hostExitCalls += 1 },
        waitForExit: () => Promise.resolve(true),
      })
      await disposeManaged(ctx.subprocess)
      expect(terminateCalls).toBe(1)
      expect(hostExitCalls).toBe(0)
      await fiber.dispose()
    }
    expect(leftoverUnhandled).toEqual([])
  })

  it('preserves leftover waitForExit refuses from an owned live handle', async () => {
    for (const leftover of LEFTOVERS) {
      const ctx = new Context()
      const fiber = await ctx.plugin(LocalSubprocessRuntime)
      let hostExitCalls = 0
      let terminateCalls = 0
      ownSet(ctx.subprocess, 'live').add({
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => { terminateCalls += 1 },
        terminateForHostExit: () => { hostExitCalls += 1 },
        waitForExit: () => Promise.reject(leftover),
      })
      await expect(disposeManaged(ctx.subprocess)).rejects.toBe(leftover)
      expect(terminateCalls).toBe(1)
      expect(hostExitCalls).toBe(1)
      leftoverUnhandled.length = 0
      await fiber.dispose()
    }
    expect(leftoverUnhandled).toEqual([])
  })

  it('preserves leftover spawnTerminal abort refuses', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    await expect(ctx.subprocess.spawnTerminal({
      argv: [process.execPath],
      cwd: process.cwd(),
      rows: 24,
      cols: 80,
      graceMs: 50,
      signal: AbortSignal.abort('leftover terminal abort'),
    })).rejects.toBe('leftover terminal abort')
    await fiber.dispose()
    expect(leftoverUnhandled).toEqual([])
  })

  it('claims leftover terminal settlement after a real spawn', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = await ctx.subprocess.spawnTerminal({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      rows: 24,
      cols: 80,
      graceMs: 50,
    })
    await handle.terminate()
    await handle.done
    await fiber.dispose()
    expect(leftoverUnhandled).toEqual([])
  })

  it('uses an owned leftover inspector when spawning a terminal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    let snapshots = 0
    Reflect.set(ctx.subprocess, 'terminalInspector', {
      foregroundPgid: () => undefined,
      isStdinWaiting: () => false,
      snapshot: () => {
        snapshots += 1
        return { tree: () => [], session: () => [], alive: () => false }
      },
      isAlive: () => false,
      signalGroup: () => { snapshots += 1 },
      signalProcess: () => { snapshots += 1 },
    })
    const handle = await ctx.subprocess.spawnTerminal({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      rows: 24,
      cols: 80,
      graceMs: 50,
    })
    expect(snapshots).toBeGreaterThan(0)
    await handle.terminate()
    await handle.done
    await fiber.dispose()
    expect(leftoverUnhandled).toEqual([])
  })

  it('releases leftover terminal ownership after the child exits', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = await ctx.subprocess.spawnTerminal({
      argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 50)'],
      cwd: process.cwd(),
      rows: 24,
      cols: 80,
      graceMs: 50,
    })
    expect(ownSet(ctx.subprocess, 'terminals').size).toBe(1)
    await handle.done
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(ownSet(ctx.subprocess, 'terminals').size).toBe(0)
    await fiber.dispose()
    expect(leftoverUnhandled).toEqual([])
  })

  it('preserves leftover terminal terminate refuses after automatic settlement', async () => {
    const leftover = { tag: 'leftover-terminal-cleanup' }
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const handle = await ctx.subprocess.spawnTerminal({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      rows: 24,
      cols: 80,
      graceMs: 50,
    })
    handle.terminate = () => Promise.reject(leftover)
    process.kill(handle.pid, 'SIGTERM')
    await handle.done
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(ownSet(ctx.subprocess, 'terminals').size).toBe(1)
    await expect(disposeManaged(ctx.subprocess)).rejects.toBe(leftover)
    await fiber.dispose()
    expect(leftoverUnhandled).toEqual([])
  })

  it('aggregates leftover terminal terminate refuses', async () => {
    const first = 'leftover terminal string'
    const second = { tag: 'leftover-terminal-object' }
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const terminals = ownSet(ctx.subprocess, 'terminals')
    let hostExitCalls = 0
    terminals.add({
      terminate: () => Promise.reject(first),
      terminateForHostExit: () => { hostExitCalls += 1 },
    })
    terminals.add({
      terminate: () => Promise.reject(second),
      terminateForHostExit: () => { hostExitCalls += 1 },
    })
    await expect(disposeManaged(ctx.subprocess)).rejects.toMatchObject({
      errors: [first, second],
      message: 'local subprocess teardown failed',
    })
    expect(hostExitCalls).toBe(2)
    await fiber.dispose()
    expect(leftoverUnhandled).toEqual([])
  })
})
