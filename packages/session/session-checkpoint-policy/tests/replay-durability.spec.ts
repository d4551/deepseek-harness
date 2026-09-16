import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { installLlmReplay } from '@deepseek-ai/dsh-llm-replay'
import * as checkpointPolicy from '../src/index.ts'

async function obstructedReplay(replayFirst: boolean, prepare = false, calls = 1) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-replay-durability-'))
  const ctx = new Context()
  const repairs: Array<() => Promise<void>> = []
  onTestFinished(async () => {
    for (const repair of repairs) await repair()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const session = ctx.sessions.create(SessionId('replay-durability'))
  await ctx.sessionPersistence.ensureMaterialized(session)
  const location = ctx.sessionPersistence.locate(session.header)
  if (location?.kind !== 'jsonl') throw new Error('Expected a JSONL persistence location')
  const baseline = await readFile(location.path, 'utf8')
  const file = join(root, 'recorded.jsonl')
  const chunks: StreamChunk[] = [
    { type: 'finish', reason: { kind: 'stop' } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  const events = Array.from({ length: calls }, (_, index) => ({
    type: 'assistant/chunk', seq: index, time: index,
    data: { turn: index + 1, step: 1, chunk: chunks[index] },
  }))
  await writeFile(file, `${[session.header, ...events].map(value => JSON.stringify(value)).join('\n')}\n`)
  const catalog = prepare ? installLlmReplay(ctx, { file, providers: [{ id: 'recorded' }] }) : undefined
  if (!replayFirst) await ctx.plugin(checkpointPolicy)
  const replay = installLlmReplay(ctx, { file })
  if (replayFirst) await ctx.plugin(checkpointPolicy)
  const saved = join(root, 'durable-prefix.jsonl')
  await rename(location.path, saved)
  await mkdir(location.path)
  let obstructed = true
  const restore = async (): Promise<void> => {
    if (!obstructed) return
    await rm(location.path, { recursive: true })
    await rename(saved, location.path)
    obstructed = false
    await ctx.sessions.flush(session)
  }
  repairs.push(restore)
  const request: GenerateOptions = {
    provider: 'recorded', model: 'recorded', messages: [], sessionId: session.id,
  }
  const prepared = prepare ? await ctx.llm.prepareCall({ provider: request.provider, model: request.model }) : undefined
  session.append('request/header', {
    header: { config: { provider: request.provider, model: request.model } }, reason: 'initial',
  })
  await expect(ctx.sessions.flush(session)).rejects.toMatchObject({
    syscall: 'open', path: location.path,
  })
  expect(await readFile(saved, 'utf8')).toBe(baseline)
  return { ctx, request, replay, prepared, catalog, restore, chunks, location, session }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

it.each([true, false])('does not consume replay at stream construction when replay-first is %s', async (replayFirst) => {
  const { ctx, request, replay } = await obstructedReplay(replayFirst)
  const stream = ctx.llm.stream(request)
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
  await expect(collect(stream)).rejects.toMatchObject({ name: 'AggregateError', errors: [{ syscall: 'open' }] })
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
})

it.each([true, false])('rejects terminal replay on failed durable flush when replay-first is %s', async (replayFirst) => {
  const { ctx, request, replay } = await obstructedReplay(replayFirst)
  await expect(collect(ctx.llm.stream(request))).rejects.toMatchObject({ name: 'AggregateError', errors: [{ syscall: 'open' }] })
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
})

it.each([true, false])('keeps prepared calls behind durable flush when replay-first is %s', async (replayFirst) => {
  const { request, replay, prepared, catalog } = await obstructedReplay(replayFirst, true)
  if (prepared === undefined || catalog === undefined) throw new Error('Expected a prepared production replay route')
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
  expect(() => { catalog.assertConsumed() }).toThrow('never bound to a live session')
  const stream = prepared.stream(request)
  await expect(collect(stream)).rejects.toMatchObject({ name: 'AggregateError', errors: [{ syscall: 'open' }] })
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
  expect(() => { catalog.assertConsumed() }).toThrow('never bound to a live session')
})

it.each([false, true])('preserves the first replay entry after failed readiness for prepared=%s', async (prepare) => {
  const { ctx, request, replay, prepared, restore, chunks, location } = await obstructedReplay(true, prepare)
  const failed = prepared === undefined ? ctx.llm.stream(request) : prepared.stream(request)
  await expect(collect(failed)).rejects.toMatchObject({
    name: 'AggregateError', errors: [{ syscall: 'open', path: location.path }],
  })
  if (prepared !== undefined) {
    expect(() => prepared.stream(request)).toThrow('can only be dispatched once')
  }
  await restore()
  const retry = prepare ? await ctx.llm.prepareCall({ provider: request.provider, model: request.model }) : undefined
  expect(await collect(retry === undefined ? ctx.llm.stream(request) : retry.stream(request))).toEqual([chunks[0]])
  replay.assertConsumed()
  expect(await readFile(location.path, 'utf8')).toContain('request/header')
})

it.each([false, true])('assigns replay entries at dispatch when streams are iterated in reverse, prepared=%s', async (prepare) => {
  const { ctx, request, replay, prepared, restore, chunks } = await obstructedReplay(true, prepare, 2)
  await restore()
  const secondPrepared = prepare ? await ctx.llm.prepareCall({ provider: request.provider, model: request.model }) : undefined
  const first = prepared === undefined ? ctx.llm.stream(request) : prepared.stream(request)
  const second = secondPrepared === undefined ? ctx.llm.stream(request) : secondPrepared.stream(request)
  if (prepared !== undefined) expect(() => prepared.stream(request)).toThrow('can only be dispatched once')
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
  expect(await collect(second)).toEqual([chunks[0]])
  expect(await collect(first)).toEqual([chunks[1]])
  replay.assertConsumed()
})

it.each([false, true])('does not start readiness or consume replay after predispatch cancellation, prepared=%s', async (prepare) => {
  const { ctx, request, replay, prepared } = await obstructedReplay(true, prepare)
  let ready = false
  ctx.on('llm/request-ready', () => { ready = true })
  const controller = new AbortController()
  controller.abort('cancelled before readiness')
  const cancelled = { ...request, signal: controller.signal }
  const stream = prepared === undefined ? ctx.llm.stream(cancelled) : prepared.stream(cancelled)
  expect(await collect(stream)).toEqual([{
    type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled before readiness', code: 'ABORTED' } },
  }])
  expect(ready).toBe(false)
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
})

it.each([false, true])('owns every readiness listener through cancellation, prepared=%s', async (prepare) => {
  const { ctx, request, replay, prepared, restore } = await obstructedReplay(true, prepare)
  await restore()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let completed = false
  ctx.on('llm/request-ready', async () => {
    entered.resolve(undefined)
    await release.promise
    completed = true
  })
  const controller = new AbortController()
  const cancelled = { ...request, signal: controller.signal }
  const pending = collect(prepared === undefined ? ctx.llm.stream(cancelled) : prepared.stream(cancelled))
  let settled = false
  const observed = Promise.allSettled([pending]).then((results) => {
    settled = true
    return results
  })
  await entered.promise
  controller.abort('cancelled during readiness')
  await setImmediate()
  expect(settled).toBe(false)
  expect(completed).toBe(false)
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
  release.resolve(undefined)
  expect(await observed).toEqual([{ status: 'fulfilled', value: [{
    type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled during readiness', code: 'ABORTED' } },
  }] }])
  expect(completed).toBe(true)
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
})

it.each([false, true])('awaits all readiness listeners before reporting checkpoint failure, cancelled=%s', async (cancelled) => {
  const { ctx, request, replay, location } = await obstructedReplay(true)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let completed = false
  ctx.on('llm/request-ready', async () => {
    entered.resolve(undefined)
    await release.promise
    completed = true
  })
  const controller = new AbortController()
  let settled = false
  const observed = Promise.allSettled([collect(ctx.llm.stream({ ...request, signal: controller.signal }))]).then((results) => {
    settled = true
    return results
  })
  await entered.promise
  if (cancelled) controller.abort('cancelled during failed readiness')
  await setImmediate()
  expect(settled).toBe(false)
  expect(completed).toBe(false)
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
  release.resolve(undefined)
  expect(await observed).toMatchObject([{ status: 'rejected', reason: {
    name: 'AggregateError', errors: [{ syscall: 'open', path: location.path }],
  } }])
  expect(completed).toBe(true)
  expect(() => { replay.assertConsumed() }).toThrow('never bound to a live session')
})
