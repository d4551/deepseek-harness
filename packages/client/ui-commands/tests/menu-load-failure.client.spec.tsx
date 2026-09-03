// @vitest-environment jsdom
/**
 * The '/' menu against a `commands/list` that answers an application error —
 * the defect this suite pins: a failing catalog used to leave the menu with a
 * titled, bodiless group and re-issue the request on every later draft
 * notification.
 *
 * Real composition across the seam: the registered CommandUiRuntime source
 * feeds a real InputTriggerController, whose menu store renders through the
 * real MenuView. Only the Remote and the session faces are doubles.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { InputTriggerController } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { InputTriggerSource, SourceRoster } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { MenuView } from '@deepseek-ai/dsh-client-ui-input-trigger/src/client/MenuView.tsx'
import { zh as menuZh } from '@deepseek-ai/dsh-client-ui-input-trigger/src/client/locales.ts'
import type { CommandDescriptor } from '../src/client/directory.ts'
import { CommandUiRuntime } from '../src/client/service.ts'

const SESSION = 'session-d5b2600d' as SessionId

/** The application error the Web host returns for an unmountable preset. */
const HOST_MESSAGE =
  'resume failed for session "session-d5b2600d": agent-presets: preset "meowbao" failed to mount'

const CMDS: CommandDescriptor[] = [{ name: 'plan', description: 'bare kind' }]

/** The framework-injected `t` seat of the menu overlay entry. */
const t = makeTranslate(menuZh, commonZh)

beforeEach(() => {
  // jsdom has no scrollIntoView; the menu calls it on the highlighted option.
  Element.prototype.scrollIntoView = vi.fn()
  // The pipeline records every source failure on the console; the assertions
  // below read the rendered state instead, so keep the lane quiet.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** One microtask drain: lets the source promise chain reach the menu store. */
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

/**
 * Boot the command source over a scripted `commands/list`, wire it into a real
 * per-session InputTriggerController, and render the menu.
 * @param answers - one carrier answer per `commands/list` call; the last entry repeats.
 */
async function bench(answers: readonly ('ok' | 'error')[]) {
  const ctx = new Context()
  const listCalls: SessionId[] = []
  const commandsRemote = {
    list: (sessionId: SessionId) => {
      const answer = answers[Math.min(listCalls.length, answers.length - 1)]
      listCalls.push(sessionId)
      return Promise.resolve(answer === 'ok'
        ? { ok: true as const, value: CMDS }
        : { ok: false as const, error: { code: 'internal', message: HOST_MESSAGE, details: {} } })
    },
    execute: () => Promise.resolve({ ok: true as const, value: undefined }),
  }
  ctx.provide('locale', { bind: () => (key: string) => key })
  const registered: InputTriggerSource[] = []
  ctx.provide('inputTriggers', {
    registerSource(src: InputTriggerSource) {
      registered.push(src)
      return () => { registered.splice(registered.indexOf(src), 1) }
    },
  })
  const scopes = new Map<SessionId, Context>()
  ctx.provide('sessions', {
    scope: (id: SessionId) => scopes.get(id),
    scopeOf: (c: Context) => scopeOf(c),
    subagentAddress: () => undefined,
  })
  Object.assign(new TestRemote(ctx), { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)
  await ctx.plugin(CommandUiRuntime).await()

  const scope = createScope(ctx, SESSION)
  scopes.set(SESSION, scope.ctx)
  // A second '/' source that settles empty: the live web app runs `command`
  // beside `skill`, and an all-empty roster is what used to auto-close the
  // menu the moment the command group was dropped.
  const skill: InputTriggerSource = {
    trigger: '/',
    name: 'skill',
    order: 2,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
  }
  const sources = [...registered, skill]
  const roster: SourceRoster = {
    sources: trigger => sources.filter(s => s.trigger === trigger),
    all: () => sources,
  }
  const controller = new InputTriggerController({ actx: scope.ctx, sessionId: SESSION, roster })
  render(
    <main>
      <MenuView
        menu={controller.menu}
        headers={controller.headers}
        onPick={(source, index) => { controller.pick(source, index) }}
        onCrumb={(source, index) => { controller.pickCrumb(source, index) }}
        onHover={(source, index) => { controller.hover(source, index) }}
        onRetry={(source) => { controller.retrySource(source) }}
        onDismiss={() => { controller.dismiss() }}
        t={t}
      />
    </main>,
  )
  /** Type one '/' into the composer (the controller's draft notification). */
  const type = async () => {
    await act(async () => {
      controller.track('/', 1, { tier: 'plain' }, 1)
      await tick()
    })
  }
  return { ctx, controller, listCalls, type }
}

describe("a '/' catalog load the host refuses", () => {
  it('renders the host message in an alert instead of a bodiless group', async () => {
    const { type } = await bench(['error'])
    await type()
    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('data-source')).toBe('command')
    expect(alert.textContent).toContain(HOST_MESSAGE)
    // The frame is localized; the host message rides in as data.
    expect(alert.textContent).toContain('指令加载失败')
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('settles: an unchanged draft never re-issues the request', async () => {
    const { listCalls, type } = await bench(['error'])
    await type()
    expect(listCalls).toEqual([SESSION])
    for (let i = 0; i < 30; i++) await type()
    expect(listCalls).toEqual([SESSION])
    // Still failed, still visible — the settled state is the failure itself.
    expect(screen.getByRole('alert').textContent).toContain(HOST_MESSAGE)
  })

  it('keeps the menu open, so the failure is never traded for a blank popup', async () => {
    const { controller, type } = await bench(['error'])
    await type()
    const state = controller.menu.getSnapshot()
    expect(state.open).toBe(true)
    expect(state.groups.map(g => ({ source: g.source, status: g.status }))).toEqual([
      { source: 'command', status: 'failed' },
      { source: 'skill', status: 'ready' },
    ])
  })

  it('retry re-issues the request exactly once and renders the recovered rows', async () => {
    const { listCalls, type } = await bench(['error', 'ok'])
    await type()
    expect(listCalls).toHaveLength(1)
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('button', { name: '重试' }))
      await tick()
    })
    expect(listCalls).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['planbare kind'])
  })

  it('a retry that fails again shows the new attempt, not a silent no-op', async () => {
    const { listCalls, type } = await bench(['error'])
    await type()
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('button', { name: '重试' }))
      await tick()
    })
    expect(listCalls).toHaveLength(2)
    expect(screen.getByRole('alert').textContent).toContain(HOST_MESSAGE)
  })

  it('a healthy catalog renders its rows with no alert', async () => {
    const { listCalls, type } = await bench(['ok'])
    await type()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['planbare kind'])
    expect(listCalls).toEqual([SESSION])
  })
})
