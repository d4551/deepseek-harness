/** Scoped Remote Event wiring for the browser question consumer. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DelegatablePendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { PendingQuestion, planReviewOf } from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { apply, inject } from '../src/client/index.ts'

const SESSION_ID = 'session-question' as SessionId
const SESSION_SCOPE = Symbol('question-session-scope')
const QUESTIONS = [{ id: 'mode', question: 'Choose a mode' }] as const
const PLAN_QUESTIONS: PendingQuestion['questions'] = [{
  id: 'plan',
  question: 'Approve this plan?',
  detail: '# Plan',
  options: [{ label: 'Approve' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review' as const, approve: 'Approve' },
}]
const ANSWER = { answers: [{ id: 'mode', selected: ['Fast'] }] }

/** Values a Promise reject arm may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

const leftoverAbortReasons: ReadonlyArray<readonly [string, Thrown]> = [
  ['string', 'leftover-string'],
  ['undefined', undefined],
  ['null', null],
  ['number', 7],
  ['boolean', false],
  ['bigint', 1n],
  ['symbol', Symbol.for('leftover-question')],
  ['null-prototype object', Object.create(null)],
  ['Error', new Error('boom')],
]

type QuestionRequest = {
  questions: PendingQuestion['questions']
  signal?: AbortSignal
}
type QuestionAnswer = typeof ANSWER
type QuestionNext = () => Promise<QuestionAnswer>
type QuestionListener = (
  this: Context,
  request: QuestionRequest,
  next: QuestionNext,
) => Promise<QuestionAnswer>

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    slots.register(
      { name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session' } } } as never,
      () => null,
    )
  }
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const agent = ctx.extend({ [SESSION_SCOPE]: SESSION_ID })
  const scopeOf = vi.fn<(candidate: Context) => SessionId | undefined>(candidate => (
    candidate as Context & { [SESSION_SCOPE]?: SessionId }
  )[SESSION_SCOPE])
  ctx.provide('sessions', { scopeOf } as never)
  const pending = new Map<PendingQuestion, () => Promise<void>>()
  // Stands in for uiSession.registerPendingInteraction: publish, await the
  // answer, resume the waterfall on a delegation, and remove in every outcome.
  type QuestionSettler = (
    value: PendingQuestion & DelegatablePendingInteraction<QuestionAnswer>,
    delegated: () => Promise<QuestionAnswer>,
  ) => Promise<QuestionAnswer>
  const registerPendingInteraction = vi.fn<(precedence: (value: PendingQuestion) => number) => QuestionSettler>(
    precedence => async (
      value: PendingQuestion & DelegatablePendingInteraction<QuestionAnswer>,
      delegated: () => Promise<QuestionAnswer>,
    ): Promise<QuestionAnswer> => {
      precedence(value)
      const completed = Promise.withResolvers<undefined>()
      pending.set(value, async () => {
        value.delegate()
        await completed.promise
      })
      using _settle = {
        [Symbol.dispose]: (): void => {
          pending.delete(value)
          completed.resolve(undefined)
        },
      }
      const outcome = await value.result.then(
        answered => ({ kind: 'answered' as const, answered }),
        (reason: Thrown) => (
          value.isDelegation(reason)
            ? { kind: 'delegated' as const }
            : { kind: 'failed' as const, reason }
        ),
      )
      if (outcome.kind === 'answered') return outcome.answered
      if (outcome.kind === 'delegated') return await delegated()
      throw outcome.reason
    })
  ctx.provide('uiSession', { registerPendingInteraction } as never)
  let listener: QuestionListener | undefined
  const on = vi.fn<(event: string, value: QuestionListener) => () => void>((event, value) => {
    expect(event).toBe('user-questions/request')
    listener = value
    return () => { listener = undefined }
  })
  ctx.provide('remote', { $on: on } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const invoke = (
    owner: Context,
    request: QuestionRequest,
    next: QuestionNext,
  ): Promise<QuestionAnswer> => {
    if (listener === undefined) throw new Error('question listener was not installed')
    return listener.call(owner, request, next)
  }
  return {
    ctx,
    slots,
    locale,
    agent,
    scopeOf,
    pending: { getSnapshot: () => [...pending.keys()] },
    registerPendingInteraction,
    on,
    fiber,
    invoke,
    async releasePending() {
      const delegates = [...pending.values()]
      pending.clear()
      await Promise.allSettled(delegates.map(delegate => delegate()))
    },
  }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'remote', 'uiSession', 'slots', 'locale'])
  })

  it('installs the Remote Event listener and delegates an unscoped request', async () => {
    const b = await bench(false)
    const next = vi.fn<QuestionNext>(async () => ANSWER)

    await expect(b.invoke(b.ctx, { questions: QUESTIONS }, next)).resolves.toBe(ANSWER)

    expect(b.on).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledOnce()
    expect(b.slots.entries('conversation.composer')).toHaveLength(0)
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('projects a scoped request through one stable composer and returns its answer', async () => {
    const b = await bench()
    const next = vi.fn<QuestionNext>(async () => ANSWER)
    const result = b.invoke(b.agent, { questions: QUESTIONS }, next)
    await Promise.resolve()

    const entry = b.slots.entries('conversation.composer')[0]!
    expect(entry.component).toBe(QuestionComposer)
    expect(entry.inject).toBeUndefined()
    expect(entry.locale).toBe('question')
    const store = entry.store as ReturnType<typeof createQuestionDraftStore>
    expect(store.create(SESSION_ID).getSnapshot()).toEqual({
      progress: { index: 0, drafts: [] },
    })
    const pending = b.pending.getSnapshot()[0]!
    const select = entry.select as (
      owner: { pendingInteraction: PendingQuestion | undefined },
    ) => PendingQuestion | null
    expect(select({ pendingInteraction: undefined })).toBeNull()
    expect(select({ pendingInteraction: pending })).toBe(pending)
    expect(pending).toMatchObject({ kind: 'question', sessionId: SESSION_ID, questions: QUESTIONS })

    await pending.answer(ANSWER)
    await expect(result).resolves.toBe(ANSWER)
    expect(next).not.toHaveBeenCalled()
    expect(b.pending.getSnapshot()).toEqual([])
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)
  })

  it('preserves ASK_CANCELLED as a rejected waterfall result', async () => {
    const b = await bench()
    const result = b.invoke(b.agent, { questions: QUESTIONS }, async () => ANSWER)
    await Promise.resolve()
    const pending = b.pending.getSnapshot()[0]!
    const rejection = result.then(
      () => { throw new Error('expected ASK_CANCELLED') },
      (reason: Thrown) => reason,
    )

    await pending.cancel()
    await expect(rejection).resolves.toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
      message: 'the user cancelled ask_user_question',
    })
    expect(b.pending.getSnapshot()).toEqual([])
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)
  })

  it('publishes a plan-review request with its distinct interaction kind', async () => {
    const b = await bench()
    const result = b.invoke(b.agent, { questions: PLAN_QUESTIONS }, async () => ANSWER)
    await Promise.resolve()
    const pending = b.pending.getSnapshot()[0]!

    expect(pending.kind).toBe('plan-review')
    await pending.answer(ANSWER)
    await expect(result).resolves.toBe(ANSWER)
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('removes a cancelled request while preserving the stable composer', async () => {
    const b = await bench()
    const controller = new AbortController()
    const result = b.invoke(b.agent, { questions: QUESTIONS, signal: controller.signal }, async () => ANSWER)
    await Promise.resolve()
    expect(b.pending.getSnapshot()).toHaveLength(1)

    controller.abort()

    await expect(result).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(b.pending.getSnapshot()).toEqual([])
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)
  })

  it('delegates an active request when its interaction domain unloads', async () => {
    const b = await bench()
    const next = vi.fn<QuestionNext>(async () => ANSWER)
    const result = b.invoke(b.agent, { questions: QUESTIONS }, next)
    await Promise.resolve()
    expect(b.pending.getSnapshot()).toHaveLength(1)

    await b.releasePending()

    await expect(result).resolves.toBe(ANSWER)
    expect(next).toHaveBeenCalledOnce()
    expect(b.pending.getSnapshot()).toEqual([])
  })

  it('removes the stable composer with the plugin lifetime', async () => {
    const b = await bench()
    expect(b.slots.entries('conversation.composer')).toHaveLength(1)

    await b.fiber.dispose()

    expect(b.slots.entries('conversation.composer')).toHaveLength(0)
  })
})

describe('planReviewOf', () => {
  const planQuestion = PLAN_QUESTIONS[0]
  if (planQuestion === undefined) throw new Error('PLAN_QUESTIONS is empty')

  it('narrows a leftover plan-review request including decline', () => {
    expect(planReviewOf(PLAN_QUESTIONS)).toEqual({
      id: 'plan',
      question: 'Approve this plan?',
      plan: '# Plan',
      approve: { label: 'Approve' },
      decline: { label: 'Keep planning' },
    })
  })

  it('leaves decline absent when the asker offered approve alone', () => {
    const review = planReviewOf([{ ...planQuestion, options: [{ label: 'Approve' }] }])
    expect(review?.approve).toEqual({ label: 'Approve' })
    expect(review === undefined ? true : 'decline' in review).toBe(false)
  })

  it.each([
    ['a batch of more than one question', (): PendingQuestion['questions'] => [
      ...PLAN_QUESTIONS,
      ...PLAN_QUESTIONS,
    ]],
    ['no intent at all', (): PendingQuestion['questions'] => {
      const { intent: _intent, ...withoutIntent } = planQuestion
      return [withoutIntent]
    }],
    ['an intent without the plan as detail', (): PendingQuestion['questions'] => {
      const { detail: _detail, ...withoutDetail } = planQuestion
      return [withoutDetail]
    }],
    ['an intent whose approve names no option', (): PendingQuestion['questions'] => [{
      ...planQuestion, intent: { kind: 'plan-review', approve: 'Ship it' },
    }]],
    ['an intent with no options at all', (): PendingQuestion['questions'] => {
      const { options: _options, ...withoutOptions } = planQuestion
      return [withoutOptions]
    }],
    ['a third option the card could not offer', (): PendingQuestion['questions'] => [{
      ...planQuestion,
      options: [{ label: 'Approve' }, { label: 'Keep planning' }, { label: 'Start over' }],
    }]],
    ['a multi-select decision', (): PendingQuestion['questions'] => [{
      ...planQuestion, multiSelect: true,
    }]],
  ])('declines %s, leaving the request to the generic flow', (_case, build) => {
    expect(planReviewOf(build())).toBeUndefined()
  })

  it('declines an empty batch', () => {
    expect(planReviewOf([])).toBeUndefined()
  })

  it('declines a one-slot batch with no question at the index', () => {
    const questions: Array<PendingQuestion['questions'][number]> = []
    questions.length = 1
    expect(planReviewOf(questions)).toBeUndefined()
  })
})

describe('PendingQuestion', () => {
  it('preserves an already-aborted request signal as ASK_ABORTED', async () => {
    const lifetime = new AbortController()
    lifetime.abort()
    const pending = new PendingQuestion(SESSION_ID, QUESTIONS, lifetime.signal)

    await expect(pending.result).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_ABORTED',
      message: 'ask_user_question was aborted before the user answered',
    })
  })

  it('rejects on later request cancellation and removes the listener after settlement', async () => {
    const lifetime = new AbortController()
    const remove = vi.spyOn(lifetime.signal, 'removeEventListener')
    const pending = new PendingQuestion(SESSION_ID, QUESTIONS, lifetime.signal)
    const rejected = pending.result.then(
      () => { throw new Error('expected ASK_ABORTED') },
      (reason: Thrown) => reason,
    )

    lifetime.abort()

    await expect(rejected).resolves.toMatchObject({ code: 'ASK_ABORTED' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('ignores a lifecycle abort after the answer already settled', async () => {
    const lifetime = new AbortController()
    const pending = new PendingQuestion(SESSION_ID, QUESTIONS, lifetime.signal)

    await pending.answer(ANSWER)
    await expect(pending.result).resolves.toBe(ANSWER)
    pending.abort(new Error('late disposal'))
    pending.delegate()
  })

  it('rejects an unanswered request with its caller-owned lifecycle reason', async () => {
    const pending = new PendingQuestion(SESSION_ID, QUESTIONS)
    const reason = new Error('scope released')
    const rejected = pending.result.then(
      () => { throw new Error('expected leftover abort') },
      (received: Thrown) => received,
    )

    pending.abort(reason)

    await expect(rejected).resolves.toBe(reason)
  })

  it.each(leftoverAbortReasons)('claims leftover abort Promise reject (%s)', async (_label, reason) => {
    const pending = new PendingQuestion(SESSION_ID, QUESTIONS)
    const rejected = pending.result.then(
      () => { throw new Error('expected leftover abort') },
      (received: Thrown) => received,
    )
    pending.abort(reason)
    await expect(rejected).resolves.toBe(reason)
  })

  it('claims leftover delegation Thrown and refuses other leftover reject reasons', async () => {
    const pending = new PendingQuestion(SESSION_ID, QUESTIONS)
    const settled = pending.result.then(
      () => { throw new Error('expected leftover delegation') },
      (reason: Thrown) => {
        expect(pending.isDelegation(reason)).toBe(true)
        expect(pending.isDelegation('leftover-string')).toBe(false)
        expect(pending.isDelegation(undefined)).toBe(false)
        return reason
      },
    )
    pending.delegate()
    await settled
  })

  it('wraps a non-Error answer settlement failure with its cause', async () => {
    const failure = 'resolve failed'
    const completion = Promise.withResolvers<QuestionAnswer>()
    const withResolvers = vi.spyOn(Promise, 'withResolvers').mockImplementationOnce(() => ({
      promise: completion.promise,
      resolve: () => { throw failure },
      reject: completion.reject,
    }))
    const pending = new PendingQuestion(SESSION_ID, QUESTIONS)
    withResolvers.mockRestore()

    const settlement = await pending.answer(ANSWER).then(
      undefined,
      (error: Thrown) => error,
    )

    expect(settlement).toBeInstanceOf(Error)
    expect(settlement).toMatchObject({
      message: 'pending question settlement failed',
      cause: failure,
    })
    completion.resolve(ANSWER)
    await expect(pending.result).resolves.toBe(ANSWER)
  })

  it('wraps a non-Error cancellation settlement failure with its cause', async () => {
    const failure = 'reject failed'
    const completion = Promise.withResolvers<QuestionAnswer>()
    const withResolvers = vi.spyOn(Promise, 'withResolvers').mockImplementationOnce(<T>() => ({
      promise: completion.promise,
      resolve: completion.resolve as (value: T | PromiseLike<T>) => void,
      reject: () => { throw failure },
    }))
    const pending = new PendingQuestion(SESSION_ID, QUESTIONS)
    withResolvers.mockRestore()

    const settlement = await pending.cancel().then(
      undefined,
      (error: Thrown) => error,
    )

    expect(settlement).toBeInstanceOf(Error)
    expect(settlement).toMatchObject({
      message: 'pending question cancellation failed',
      cause: failure,
    })
    completion.resolve(ANSWER)
    await expect(pending.result).resolves.toBe(ANSWER)
  })
})
