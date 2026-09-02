import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

const NO_CAPS: SubagentCapabilities = {
  agentOptions: false,
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
}

/** Let every already-resolved continuation run before observing admission state. */
function drain(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

interface Settlement {
  readonly promise: Promise<SubagentResult>
  resolve(result: SubagentResult): void
  reject(error: unknown): void
}

function settlement(): Settlement {
  let resolve!: (result: SubagentResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<SubagentResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A provider whose runs settle only when this test says so, so each settlement
 * path can be exercised on its own.
 */
class ControlledProvider implements SubagentProvider {
  readonly name = 'controlled'
  readonly capabilities = NO_CAPS
  readonly inheritsParentContext = false
  /** Labels in the order the service dispatched them. */
  readonly dispatched: string[] = []
  readonly disposed: string[] = []
  private readonly settlements = new Map<string, Settlement>()
  /** Armed by a test to make the next dispatch reject before publication. */
  startFailure: Error | undefined

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const label = request.label ?? 'unlabelled'
    this.dispatched.push(label)
    if (this.startFailure !== undefined) {
      const failure = this.startFailure
      this.startFailure = undefined
      return Promise.reject(failure)
    }
    const pending = settlement()
    this.settlements.set(label, pending)
    return Promise.resolve({
      id: SessionId(`child-${label}`),
      localAgent: undefined,
      result: pending.promise,
      // Disposal deliberately leaves `result` pending so a test can prove that
      // disposal alone returns the slot.
      dispose: (): Promise<void> => {
        this.disposed.push(label)
        return Promise.resolve()
      },
    })
  }

  complete(label: string): void {
    this.expect(label).resolve({ output: [{ type: 'text', text: label }], stopReason: 'completed' })
  }

  fail(label: string, error: unknown): void {
    this.expect(label).reject(error)
  }

  private expect(label: string): Settlement {
    const pending = this.settlements.get(label)
    if (pending === undefined) throw new Error(`no controlled run named "${label}"`)
    return pending
  }
}

function parent(id = 'capacity-parent'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

function request(label: string, signal = new AbortController().signal): SubagentStartRequest {
  return { label, prompt: [{ type: 'text', text: label }], parent: parent(), signal }
}

async function harness(maxConcurrentRuns: number) {
  const ctx = new Context()
  const fiber = await ctx.plugin(SubagentRuntime, { maxConcurrentRuns })
  const provider = new ControlledProvider()
  ctx.subagents.registerProvider(provider)
  return { ctx, fiber, provider, subagents: ctx.subagents }
}

describe('one-shot run admission', () => {
  it('fills its default bound when the deployment states none', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    expect(ctx.subagents.capacity()).toEqual({ limit: 16, active: 0, waiting: 0 })
  })

  it('rejects a bound that is not a positive integer at load', async () => {
    const ctx = new Context()
    for (const maxConcurrentRuns of [0, -1, 2.5]) {
      await expect(ctx.plugin(SubagentRuntime, { maxConcurrentRuns })).rejects.toThrow(/maxConcurrentRuns/)
    }
  })

  it('dispatches up to the bound and holds the rest until a run settles', async () => {
    const { provider, subagents } = await harness(2)
    const first = await subagents.start('controlled', request('a'))
    const second = await subagents.start('controlled', request('b'))
    const third = subagents.start('controlled', request('c'))
    await drain()

    expect(provider.dispatched).toEqual(['a', 'b'])
    expect(subagents.capacity()).toEqual({ limit: 2, active: 2, waiting: 1 })

    provider.complete('a')
    await expect(first.result).resolves.toMatchObject({ stopReason: 'completed' })
    await third
    expect(provider.dispatched).toEqual(['a', 'b', 'c'])
    expect(subagents.capacity()).toEqual({ limit: 2, active: 2, waiting: 0 })

    provider.complete('b')
    provider.complete('c')
    await second.result
    await drain()
    expect(subagents.capacity()).toEqual({ limit: 2, active: 0, waiting: 0 })
  })

  it('admits waiting starts in arrival order', async () => {
    const { provider, subagents } = await harness(1)
    const held = await subagents.start('controlled', request('held'))
    const queued = ['first', 'second', 'third'].map(label => subagents.start('controlled', request(label)))
    await drain()
    expect(provider.dispatched).toEqual(['held'])
    expect(subagents.capacity().waiting).toBe(3)

    await held.dispose()
    const first = await queued[0]!
    expect(provider.dispatched).toEqual(['held', 'first'])
    await first.dispose()
    const second = await queued[1]!
    expect(provider.dispatched).toEqual(['held', 'first', 'second'])
    await second.dispose()
    await queued[2]
    expect(provider.dispatched).toEqual(['held', 'first', 'second', 'third'])
  })

  it('returns the slot on a resolved result, a rejected result, and disposal', async () => {
    for (const settle of ['complete', 'fail', 'dispose'] as const) {
      const { provider, subagents } = await harness(1)
      const held = await subagents.start('controlled', request('held'))
      const queued = subagents.start('controlled', request('next'))
      await drain()
      expect(provider.dispatched).toEqual(['held'])

      switch (settle) {
        case 'complete':
          provider.complete('held')
          await expect(held.result).resolves.toMatchObject({ stopReason: 'completed' })
          break
        case 'fail':
          provider.fail('held', new Error('infrastructure fault'))
          await expect(held.result).rejects.toThrow('infrastructure fault')
          break
        case 'dispose':
          await held.dispose()
          expect(provider.disposed).toEqual(['held'])
          break
      }

      await queued
      expect(provider.dispatched, `${settle} did not release the slot`).toEqual(['held', 'next'])
      expect(subagents.capacity()).toEqual({ limit: 1, active: 1, waiting: 0 })
    }
  })

  it('returns the slot when the provider rejects before publication', async () => {
    const { provider, subagents } = await harness(1)
    provider.startFailure = new Error('provider could not establish the child')
    await expect(subagents.start('controlled', request('doomed')))
      .rejects.toThrow('provider could not establish the child')
    expect(subagents.capacity()).toEqual({ limit: 1, active: 0, waiting: 0 })

    const recovered = await subagents.start('controlled', request('after'))
    expect(provider.dispatched).toEqual(['doomed', 'after'])
    await recovered.dispose()
  })

  it('keeps disposal one memoized teardown that returns the slot once', async () => {
    const { provider, subagents } = await harness(1)
    const run = await subagents.start('controlled', request('idempotent'))
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal
    expect(provider.disposed).toEqual(['idempotent'])
    expect(subagents.capacity()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('settles a cancelled waiting start as cancelled without consuming a slot', async () => {
    const { provider, subagents } = await harness(1)
    const held = await subagents.start('controlled', request('held'))
    const controller = new AbortController()
    const cancelled = subagents.start('controlled', request('cancelled', controller.signal))
    const survivor = subagents.start('controlled', request('survivor'))
    await drain()
    expect(subagents.capacity()).toEqual({ limit: 1, active: 1, waiting: 2 })

    controller.abort(new Error('the caller went away'))
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' })
    // The cancelled start never reached the provider and freed no slot of its own.
    expect(provider.dispatched).toEqual(['held'])
    expect(subagents.capacity()).toEqual({ limit: 1, active: 1, waiting: 1 })

    await held.dispose()
    await survivor
    expect(provider.dispatched).toEqual(['held', 'survivor'])
  })

  it('leaves an already-cancelled start to the provider while a slot is free', async () => {
    const { provider, subagents } = await harness(1)
    const controller = new AbortController()
    controller.abort(new Error('cancelled before asking'))
    const run = await subagents.start('controlled', request('unbounded', controller.signal))

    // Below the bound the seam is transparent, so the provider keeps owning
    // pre-publication cancellation exactly as it does with no ceiling.
    expect(provider.dispatched).toEqual(['unbounded'])
    await run.dispose()
  })

  it('cancels the starts still waiting when the service unloads', async () => {
    const { fiber, subagents } = await harness(1)
    const held = await subagents.start('controlled', request('held'))
    const queued = subagents.start('controlled', request('never'))
    await drain()

    await fiber.dispose()
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' })
    await held.dispose()
  })
})
