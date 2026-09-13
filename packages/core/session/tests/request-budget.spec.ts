import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'

const policy = Object.freeze({ policyId: 'test/request-policy', maxAgentAttempts: 2, maxRootAttempts: 3 })
const signal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const root = ctx.sessions.create(SessionId('root'))
  const child = ctx.sessions.create(SessionId('child'))
  return { ctx, root, child, budgets: ctx.sessions.requestBudgets }
}

function human(text = 'Human work'): UserMessage {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function logHuman(root: Session, message = human()): UserMessage {
  const turn = root.events.filter(event => event.type === 'turn/start').length + 1
  root.append('turn/start', { turn })
  root.append('user/message', message, { surfaceOp: 'append' })
  root.append('turn/end', { turn, reason: { kind: 'completed' } })
  return message
}

it('reserves exact actor and root counts while the root is idle, enforcing both limits', async () => {
  const { ctx, root, child, budgets } = await setup()
  const flushed: Session[] = []
  ctx.on('session/flush', (session) => { flushed.push(session) })
  const message = logHuman(root)
  budgets.admit(root, policy, message.id)
  await expect(budgets.reserve(root, child, policy, signal)).resolves.toMatchObject({ actorAttempt: 1, rootAttempt: 1 })
  await expect(budgets.reserve(root, child, policy, signal)).resolves.toMatchObject({ actorAttempt: 2, rootAttempt: 2 })
  await expect(budgets.reserve(root, child, policy, signal)).rejects.toThrow('agent child used 2/2')
  await expect(budgets.reserve(root, root, policy, signal)).resolves.toMatchObject({ actorAttempt: 1, rootAttempt: 3 })
  await expect(budgets.reserve(root, root, policy, signal)).rejects.toThrow('root root used 3/3')
  expect(flushed).toEqual([root, root, root])
  expect(root.events.filter(event => event.type === 'request/attempt')).toHaveLength(3)
  expect(child.events).toEqual([])
})

it('cannot renew from pending, discarded, historical, or repeated input identities', async () => {
  const { ctx, root, budgets } = await setup()
  const flushed: string[] = []
  ctx.on('session/flush', (session) => { flushed.push(session.id) })
  const pending = human()
  budgets.offer(root, policy, pending.id)
  await expect(budgets.reserve(root, root, policy, signal)).rejects.toThrow('authenticated human')
  expect(root.events).toEqual([])
  budgets.discard(root, policy, pending.id)
  logHuman(root, pending)
  await expect(budgets.reserve(root, root, policy, signal)).rejects.toThrow('authenticated human')
  expect(() => { budgets.offer(root, policy, pending.id) }).toThrow('historical input')
  const accepted = human('New work')
  budgets.offer(root, policy, accepted.id)
  logHuman(root, accepted)
  await budgets.reserve(root, root, policy, signal)
  expect(() => { budgets.admit(root, policy, accepted.id) }).toThrow('repeats an admitted message')
  expect(root.events.filter(event => event.type === 'request/episode')).toHaveLength(1)
  expect(flushed).toEqual(['root'])
})

it('accepts newly logged root human work from a child reservation without refunding history', async () => {
  const { ctx, root, child, budgets } = await setup()
  const flushed: Session[] = []
  ctx.on('session/flush', (session) => { flushed.push(session) })
  const first = logHuman(root)
  budgets.admit(root, policy, first.id)
  await budgets.reserve(root, child, policy, signal)
  await budgets.reserve(root, child, policy, signal)
  const next = human('Explicit follow-up')
  budgets.offer(root, policy, next.id)
  logHuman(root, next)
  await expect(budgets.reserve(root, child, policy, signal)).resolves.toMatchObject({
    userMessageId: next.id, actorAttempt: 1, rootAttempt: 1,
  })
  expect(root.events.filter(event => event.type === 'request/attempt').map(event => event.data.userMessageId))
    .toEqual([first.id, first.id, next.id])
  expect(flushed).toHaveLength(3)
})

it('serializes root checkpoints and denies concurrent contenders for the last shared slot', async () => {
  const { ctx, root, child, budgets } = await setup()
  const gate = Promise.withResolvers<undefined>()
  let flushes = 0
  ctx.on('session/flush', async () => {
    flushes += 1
    await gate.promise
  })
  budgets.admit(root, policy, logHuman(root).id)
  const first = budgets.reserve(root, child, policy, signal)
  const second = budgets.reserve(root, root, policy, signal)
  const third = budgets.reserve(root, child, policy, signal)
  const fourth = budgets.reserve(root, root, policy, signal)
  await expect(fourth).rejects.toThrow('root root used 3/3')
  expect(flushes).toBe(1)
  let dispatched = false
  const observed = Promise.all([first, second, third]).then((attempts) => { dispatched = true; return attempts })
  expect(dispatched).toBe(false)
  gate.resolve(undefined)
  expect((await observed).map(attempt => attempt.rootAttempt)).toEqual([1, 2, 3])
  expect(flushes).toBe(3)
})

it('denies missing and failed durability while retaining accepted reservations', async () => {
  const { ctx, root, child, budgets } = await setup()
  budgets.admit(root, policy, logHuman(root).id)
  await expect(budgets.reserve(root, child, policy, signal)).rejects.toThrow('no durability provider')
  expect(root.events.filter(event => event.type === 'request/attempt')).toHaveLength(1)
  const other = ctx.sessions.create(SessionId('other'))
  budgets.admit(other, policy, logHuman(other).id)
  ctx.on('session/flush', () => Promise.reject(new Error('disk full')))
  await expect(budgets.reserve(other, child, policy, signal)).rejects.toThrow('disk full')
  expect(other.events.filter(event => event.type === 'request/attempt')).toHaveLength(1)
})

it('retains a charge cancelled during flush and rejects stale ownership before dispatch', async () => {
  const { ctx, root, child, budgets } = await setup()
  const gate = Promise.withResolvers<undefined>()
  ctx.on('session/flush', () => gate.promise)
  budgets.admit(root, policy, logHuman(root).id)
  const controller = new AbortController()
  const attempt = budgets.reserve(root, child, policy, controller.signal)
  controller.abort(new Error('request cancelled'))
  gate.resolve(undefined)
  await expect(attempt).rejects.toThrow('request cancelled')
  expect(root.events.filter(event => event.type === 'request/attempt')).toHaveLength(1)
  await expect(budgets.reserve(root, Session.create(child.id), policy, signal)).rejects.toThrow('exact live session')
  await expect(budgets.reserve(Session.create(root.id), child, policy, signal)).rejects.toThrow('exact live session')
  expect(root.events.filter(event => event.type === 'request/attempt')).toHaveLength(1)
})

it('replays the same limits after a complete store restart and requires fresh admission for a fork', async () => {
  const { ctx, root, child, budgets } = await setup()
  const retained: Session[] = []
  ctx.on('session/flush', (session) => { retained.push(session) })
  budgets.admit(root, policy, logHuman(root).id)
  await budgets.reserve(root, child, policy, signal)
  await budgets.reserve(root, child, policy, signal)
  const restarted = new Context()
  onTestFinished(() => restarted.fiber.dispose())
  await restarted.plugin(SessionStore)
  const restored = restarted.sessions.create(root.id, { seed: structuredClone(root.events), meta: root.header })
  const restoredChild = restarted.sessions.create(child.id)
  restarted.on('session/flush', (session) => { retained.push(session) })
  await expect(restarted.sessions.requestBudgets.reserve(restored, restoredChild, policy, signal))
    .rejects.toThrow('agent child used 2/2')
  await expect(restarted.sessions.requestBudgets.reserve(restored, restored, policy, signal))
    .resolves.toMatchObject({ rootAttempt: 3 })
  const fork = restarted.sessions.fork(restored, undefined, SessionId('fork'))
  await expect(restarted.sessions.requestBudgets.reserve(fork, fork, policy, signal))
    .rejects.toThrow('authenticated human')
  expect(retained).toHaveLength(3)
})

it('rejects out-of-order reservations and episodes without earlier accepted human messages', async () => {
  const { root, child, budgets } = await setup()
  const identity = { version: 1, policyId: policy.policyId, rootSessionId: root.id, userMessageId: human().id }
  root.append('request/episode', { ...identity, version: 1 })
  await expect(budgets.reserve(root, child, policy, signal)).rejects.toThrow('earlier root human message')
  const other = await setup()
  const message = logHuman(other.root)
  other.budgets.admit(other.root, policy, message.id)
  other.root.append('request/attempt', {
    ...identity, version: 1, rootSessionId: other.root.id, userMessageId: message.id,
    actorSessionId: other.child.id, actorAttempt: 1, rootAttempt: 2,
  })
  await expect(other.budgets.reserve(other.root, other.child, policy, signal)).rejects.toThrow('not consecutive')
})

it('rejects episode renewal from older unused input before mutating the ledger', async () => {
  const { root, budgets } = await setup()
  const earlier = logHuman(root)
  const later = logHuman(root)
  budgets.admit(root, policy, later.id)
  const before = root.events
  expect(() => { budgets.admit(root, policy, earlier.id) }).toThrow('older human message')
  expect(root.events).toBe(before)
})

it('allows a distinct human episode to checkpoint repaired storage while retaining the failed charge', async () => {
  const { ctx, root, child, budgets } = await setup()
  const first = logHuman(root)
  budgets.admit(root, policy, first.id)
  const failing = ctx.on('session/flush', () => Promise.reject(new Error('storage unavailable')))
  await expect(budgets.reserve(root, child, policy, signal)).rejects.toThrow('storage unavailable')
  failing()
  const snapshots: string[][] = []
  ctx.on('session/flush', () => {
    snapshots.push(root.events.flatMap(event => event.type === 'request/attempt' ? [event.data.userMessageId] : []))
  })
  const second = logHuman(root)
  budgets.admit(root, policy, second.id)
  await expect(budgets.reserve(root, child, policy, signal)).resolves.toMatchObject({
    userMessageId: second.id, actorAttempt: 1, rootAttempt: 1,
  })
  expect(snapshots).toEqual([[first.id, second.id]])
  expect(root.events.filter(event => event.type === 'request/attempt')).toHaveLength(2)
})
