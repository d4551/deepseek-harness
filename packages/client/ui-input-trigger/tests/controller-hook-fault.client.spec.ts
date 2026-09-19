/**
 * Synchronous source hooks answer failure as `{ hookFailed: true, message }`.
 * The pipeline records that message and continues: a header fault keeps the
 * menu and sibling crumbs, a lexicon fault keeps sibling rolls, and a late
 * registerSource still notifies every live controller.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { InputTriggerController, InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  ClientSessionContext, InputTriggerSource, SourceRoster, SyncHookFault,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

afterEach(() => {
  vi.restoreAllMocks()
})

function fault(message: string): SyncHookFault {
  return { hookFailed: true, message }
}

function controllerBench(sources: InputTriggerSource[], key = 'a') {
  const root = new Context()
  const sessionId = SessionId(key)
  const scope = createScope(root, sessionId)
  const roster: SourceRoster = {
    sources: trigger => sources.filter(item => item.trigger === trigger),
    all: () => sources,
  }
  const controller = new InputTriggerController({ actx: scope.ctx, sessionId, roster })
  return { controller }
}

async function serviceBench() {
  const root = new Context()
  root.provide('sessions', {
    scopeOf: (c: Context) => scopeOf(c),
  })
  await root.plugin(InputTriggerService).await()
  const inputTriggers = root.get('inputTriggers')
  if (inputTriggers === undefined) {
    throw new Error('ui-input-trigger: inputTriggers service unavailable')
  }
  const mint = (key: string) => {
    const scope = createScope(root, SessionId(key))
    return { actx: scope.ctx }
  }
  return { inputTriggers, mint }
}

describe('header hookFailed', () => {
  it('drops a source whose header returns hookFailed and keeps the rest of the menu', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = {
      trigger: '@',
      name: 'broken',
      candidates: () => Promise.resolve([{ name: 'x' }]),
      header: () => fault('header boom'),
      onPick: () => undefined,
    } satisfies InputTriggerSource
    const healthy = {
      trigger: '@',
      name: 'reference',
      candidates: () => Promise.resolve([{ name: 'src' }]),
      header: () => [{ label: 'src', value: 'src' }],
      onPick: () => undefined,
    } satisfies InputTriggerSource
    const { controller } = controllerBench([failing, healthy])
    controller.track('@x', 2, { tier: 'plain' }, 1)
    await Promise.resolve()
    expect(controller.headers.getSnapshot().get('broken')).toBeUndefined()
    expect(controller.headers.getSnapshot().get('reference')).toEqual([{ label: 'src', value: 'src' }])
    expect(controller.menu.getSnapshot().open).toBe(true)
    expect(errorSpy).toHaveBeenCalledWith(
      '[ui-input-trigger] source "broken" header failed:',
      'header boom',
    )
  })
})

describe('lexicon hookFailed', () => {
  it('skips a source whose lexicon returns hookFailed and keeps sibling rolls', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { controller } = controllerBench([
      {
        trigger: '/',
        name: 'broken',
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        lexicon: () => fault('lexicon boom'),
      } satisfies InputTriggerSource,
      {
        trigger: '/',
        name: 'skill',
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        lexicon: () => ['review'],
      } satisfies InputTriggerSource,
    ])
    expect(controller.lexicon.getSnapshot().get('/')).toEqual(['review'])
    expect(errorSpy).toHaveBeenCalledWith(
      '[ui-input-trigger] source "broken" lexicon failed:',
      'lexicon boom',
    )
  })
})

describe('registerSource hookFailed', () => {
  it('a late source whose warm returns hookFailed still registers and notifies every live controller', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { inputTriggers, mint } = await serviceBench()
    const ca = inputTriggers.sessionOf(mint('a').actx)
    const cb = inputTriggers.sessionOf(mint('b').actx)
    const warm = vi.fn<(session: ClientSessionContext) => SyncHookFault | undefined>(
      () => fault('warm boom'),
    )
    const late = {
      trigger: '/',
      name: 'late',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      warm,
      lexicon: () => ['fresh'],
    } satisfies InputTriggerSource
    const dispose = inputTriggers.registerSource(late)
    expect(warm).toHaveBeenNthCalledWith(1, { sessionId: SessionId('a') })
    expect(warm).toHaveBeenNthCalledWith(2, { sessionId: SessionId('b') })
    expect(ca.lexicon.getSnapshot().get('/')).toEqual(['fresh'])
    expect(cb.lexicon.getSnapshot().get('/')).toEqual(['fresh'])
    expect(errorSpy).toHaveBeenCalledWith(
      '[ui-input-trigger] source "late" warm failed:',
      'warm boom',
    )
    dispose()
    expect(ca.lexicon.getSnapshot().size).toBe(0)
    expect(cb.lexicon.getSnapshot().size).toBe(0)
  })

  it('a late source whose subscribeLexicon returns hookFailed still notifies every live controller', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { inputTriggers, mint } = await serviceBench()
    const ca = inputTriggers.sessionOf(mint('a').actx)
    const cb = inputTriggers.sessionOf(mint('b').actx)
    const subscribeLexicon = vi.fn<NonNullable<InputTriggerSource['subscribeLexicon']>>(
      () => fault('subscribe boom'),
    )
    const late = {
      trigger: '/',
      name: 'late',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      lexicon: () => ['fresh'],
      subscribeLexicon,
    } satisfies InputTriggerSource
    inputTriggers.registerSource(late)
    expect(subscribeLexicon).toHaveBeenCalledTimes(2)
    expect(ca.lexicon.getSnapshot().get('/')).toEqual(['fresh'])
    expect(cb.lexicon.getSnapshot().get('/')).toEqual(['fresh'])
    expect(errorSpy).toHaveBeenCalledWith(
      '[ui-input-trigger] source "late" subscribeLexicon failed:',
      'subscribe boom',
    )
  })
})
