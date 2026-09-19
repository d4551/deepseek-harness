import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type AgentCancelCause, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { flushSchedulePersistence, SchedulePersistenceError } from '../src/persistence.ts'
import { registerScheduleTools } from '../src/tools.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

const leftoverSignal = new AbortController().signal
const leftoverContexts: Context[] = []

const leftoverRefuses: readonly Thrown[] = [
  { leftover: true },
  'leftover flush string',
  0,
  false,
  1n,
  Symbol.for('schedule-leftover'),
  null,
  undefined,
]

function leftoverObserverFn(): void {}

const leftoverObserverRefuses: readonly unknown[] = [
  undefined,
  null,
  { leftover: true },
  leftoverObserverFn,
]

function leftoverOwner(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    status: 'idle',
    ctx: new Context(),
    send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
    runMaintenance: task => task(leftoverSignal),
    cancel(_cause: AgentCancelCause) {},
    whenIdle: () => Promise.resolve(),
    followup(_message: UserMessage) {},
    steer(_message: UserMessage) {},
    inject(_message: UserMessage) {},
  }
}

async function leftoverPersistence(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  leftoverContexts.push(ctx)
  await ctx.plugin(SessionStore)
  return { ctx, session: ctx.sessions.create(SessionId(`schedule-leftover-${Math.random()}`)) }
}

async function leftoverTools(onDurableChange: () => void = () => {}): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  leftoverContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  ctx.on('session/flush', () => {})
  const agent = leftoverOwner(ctx, `schedule-leftover-tools-${Math.random()}`)
  ctx.agents.register(agent)
  registerScheduleTools(ctx, ctx, agent, onDurableChange)
  return { ctx, agent }
}

function deliverLeftoverFlush(ctx: Context, leftover: Thrown): void {
  ctx.sessions.flush = () => Promise.reject(leftover)
}

function leftoverValue(result: ToolExecutionResult): unknown {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected canonical Schedule value')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected deterministic text content')
  expect(JSON.parse(block.text)).toEqual(result.value)
  return result.value
}

function executeLeftover(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, string | number>,
): Promise<ToolExecutionResult> {
  return ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    signal: leftoverSignal,
    callId: ToolCallId(`leftover-${name}`),
    name,
    arguments: args,
    agent,
  }))
}

function expectPersistenceError(value: Thrown): SchedulePersistenceError {
  if (value instanceof SchedulePersistenceError) return value
  throw new Error('expected SchedulePersistenceError')
}

afterEach(async () => {
  await Promise.allSettled(leftoverContexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('leftover Promise reject arms', () => {
  it('refuses a flush that no durability listener acknowledged', async () => {
    const { ctx, session } = await leftoverPersistence()
    const refused = await flushSchedulePersistence(ctx, session).then(
      () => {
        throw new Error('expected leftover unacknowledged flush')
      },
      (error: Thrown) => error,
    )
    const persistence = expectPersistenceError(refused)
    expect(persistence.message).toBe('Schedule persistence did not complete.')
    expect(persistence.cause).toBeUndefined()
  })

  it.each(leftoverRefuses)('wraps leftover flush refuse %#', async (leftover) => {
    const { ctx, session } = await leftoverPersistence()
    deliverLeftoverFlush(ctx, leftover)
    const refused = await flushSchedulePersistence(ctx, session).then(
      () => {
        throw new Error('expected leftover flush refuse')
      },
      (error: Thrown) => error,
    )
    const persistence = expectPersistenceError(refused)
    expect(persistence.message).toBe('Schedule persistence did not complete.')
    expect(persistence.cause).toBe(leftover)
  })

  it.each(leftoverRefuses)('maps leftover flush refuse %# to persistence_uncertain', async (leftover) => {
    const { ctx, agent } = await leftoverTools()
    deliverLeftoverFlush(ctx, leftover)
    expect(leftoverValue(await executeLeftover(ctx, agent, 'schedule_list', {}))).toEqual({
      code: 'persistence_uncertain',
      message: 'Schedule persistence is uncertain; retry with schedule_list before relying on this result.',
      operation: 'list',
    })
    expect(leftoverValue(await executeLeftover(ctx, agent, 'schedule_create', {
      prompt: 'later',
      after_seconds: 1,
    }))).toEqual({
      code: 'persistence_uncertain',
      message: 'Schedule persistence is uncertain; retry with schedule_list before relying on this result.',
      operation: 'create',
    })
    expect(leftoverValue(await executeLeftover(ctx, agent, 'schedule_delete', { id: 'schedule-1' }))).toEqual({
      code: 'persistence_uncertain',
      message: 'Schedule persistence is uncertain; retry with schedule_list before relying on this result.',
      operation: 'delete',
      id: 'schedule-1',
    })
    expect(agent.session.events.filter(event => event.type === 'schedule/change')).toEqual([])
  })

  it('renders leftover empty-message Errors through the durable-change observer', async () => {
    const empty = new Error('')
    const unnamed = new Error('')
    delete unnamed.stack
    const blankStack = new Error('')
    blankStack.stack = ''
    const leftovers = [empty, unnamed, blankStack]
    let index = 0
    const { ctx, agent } = await leftoverTools(() => {
      const leftover = leftovers[index]
      index += 1
      throw leftover
    })
    expect(leftoverValue(await executeLeftover(ctx, agent, 'schedule_create', {
      prompt: 'still committed',
      after_seconds: 1,
    }))).toMatchObject({ id: 'schedule-1' })
    expect(leftoverValue(await executeLeftover(ctx, agent, 'schedule_list', {})))
      .toEqual([expect.objectContaining({ id: 'schedule-1' })])
    expect(index).toBe(3)
  })

  it.each(leftoverObserverRefuses)('renders leftover observer refuse %#', async (leftover) => {
    const { ctx, agent } = await leftoverTools(() => {
      throw leftover
    })
    expect(leftoverValue(await executeLeftover(ctx, agent, 'schedule_create', {
      prompt: 'still committed',
      after_seconds: 1,
    }))).toMatchObject({ id: 'schedule-1' })
  })
})
