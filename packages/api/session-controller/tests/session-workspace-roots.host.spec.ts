/**
 * The Session Controller's workspace-root surface: the `workspaceRoots`
 * projection a browser reads, the replacement command a browser sends, and the
 * deployment origin probe that tells the two apart from a mirrored workspace.
 *
 * The projection is asserted through the registry that drives it, not by
 * calling the fold directly: the point of the unit is that a committed
 * `workspace/roots` event moves the served value.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { effectiveWorkspaceRoots } from '@deepseek-ai/dsh-session/workspace-roots'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installWorkspaceRootsProjection } from '../src/workspace-roots-projection.ts'
import type { WorkspaceRootsProjection } from '../src/types.ts'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

const SESSION = SessionId('roots-session')
const PRIMARY = '/projects/primary'
const SECOND = '/projects/second'

/** Session store plus the registries the controllers resolve. */
async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return ctx
}

/** An agent controller that resolves exactly the session this spec created. */
function agentsFor(ctx: Context, sessionId: SessionId): ApiSessionAgentController {
  return {
    resolveAgent: (requested: SessionId) => {
      const session = ctx.sessions.get(requested)
      return Promise.resolve(session === undefined
        ? { error: { code: 'session-not-found', message: 'missing', details: { sessionId: requested } } }
        : { agent: { id: sessionId, session } as Agent })
    },
  } as unknown as ApiSessionAgentController
}

describe('workspaceRoots projection', () => {
  it('serves the header cwd before any root event, then the recorded set', async () => {
    const ctx = await baseContext()
    installWorkspaceRootsProjection(ctx)
    const session = ctx.sessions.create(SESSION, { meta: { cwd: PRIMARY } })

    const read = (): WorkspaceRootsProjection =>
      ctx.sessionProjections.snapshot(session).values.workspaceRoots as WorkspaceRootsProjection

    expect(read()).toEqual({ primary: PRIMARY, additional: [] })
    session.append('workspace/roots', { roots: [SECOND] })
    expect(read()).toEqual({ primary: PRIMARY, additional: [SECOND] })
    session.append('workspace/roots', { roots: [] })
    expect(read()).toEqual({ primary: PRIMARY, additional: [] })
    await ctx.fiber.dispose()
  })

  it('reports a null primary for a Session created without a cwd', async () => {
    const ctx = await baseContext()
    installWorkspaceRootsProjection(ctx)
    const session = ctx.sessions.create(SESSION)
    expect(ctx.sessionProjections.snapshot(session).values.workspaceRoots)
      .toEqual({ primary: null, additional: [] })
    await ctx.fiber.dispose()
  })

  it('leaves the served value untouched for an unrelated event', async () => {
    const ctx = await baseContext()
    installWorkspaceRootsProjection(ctx)
    const session = ctx.sessions.create(SESSION, { meta: { cwd: PRIMARY } })
    session.append('workspace/roots', { roots: [SECOND] })
    const before = ctx.sessionProjections.snapshot(session).values.workspaceRoots
    session.append('turn/start', { turn: 1 })
    expect(ctx.sessionProjections.snapshot(session).values.workspaceRoots).toEqual(before)
    await ctx.fiber.dispose()
  })

  it('holds the same value when an event restates the recorded set', async () => {
    const ctx = await baseContext()
    installWorkspaceRootsProjection(ctx)
    const session = ctx.sessions.create(SESSION, { meta: { cwd: PRIMARY } })
    session.append('workspace/roots', { roots: [SECOND] })
    // `setAdditionalWorkspaceRoots` suppresses a restatement, so the only way
    // to reach the fold's same-set path is to append the event directly.
    session.append('workspace/roots', { roots: [SECOND] })
    expect(ctx.sessionProjections.snapshot(session).values.workspaceRoots)
      .toEqual({ primary: PRIMARY, additional: [SECOND] })
    await ctx.fiber.dispose()
  })
})

describe('session.setWorkspaceRoots', () => {
  it('records the replacement set on the live Session', async () => {
    const ctx = await baseContext()
    const session = ctx.sessions.create(SESSION, { meta: { cwd: PRIMARY } })
    const controller = new SessionCommandController(ctx, agentsFor(ctx, SESSION), PRIMARY)

    expect(await controller.setWorkspaceRoots({
      sessionId: SESSION,
      additionalDirectories: [SECOND],
    })).toEqual({ additional: [SECOND] })
    expect(effectiveWorkspaceRoots(session.events)).toEqual([SECOND])

    expect(await controller.setWorkspaceRoots({
      sessionId: SESSION,
      additionalDirectories: [],
    })).toEqual({ additional: [] })
    expect(effectiveWorkspaceRoots(session.events)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('drops the primary root and duplicate spellings from the recorded set', async () => {
    const ctx = await baseContext()
    const session = ctx.sessions.create(SESSION, { meta: { cwd: PRIMARY } })
    const controller = new SessionCommandController(ctx, agentsFor(ctx, SESSION), PRIMARY)

    expect(await controller.setWorkspaceRoots({
      sessionId: SESSION,
      additionalDirectories: [SECOND, PRIMARY, SECOND],
    })).toEqual({ additional: [SECOND] })
    expect(session.events.filter(event => event.type === 'workspace/roots')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('rejects a relative root before the Session is resolved', async () => {
    const ctx = await baseContext()
    const session = ctx.sessions.create(SESSION, { meta: { cwd: PRIMARY } })
    const resolveAgent = vi.fn()
    const controller = new SessionCommandController(
      ctx,
      { resolveAgent } as unknown as ApiSessionAgentController,
      PRIMARY,
    )

    await expect(controller.setWorkspaceRoots({
      sessionId: SESSION,
      additionalDirectories: [SECOND, 'relative/dir'],
    })).rejects.toMatchObject({ failure: { code: 'bad-request', details: { directory: 'relative/dir' } } })
    expect(resolveAgent).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type === 'workspace/roots')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('refuses a Session this deployment cannot resolve', async () => {
    const ctx = await baseContext()
    const controller = new SessionCommandController(ctx, agentsFor(ctx, SESSION), PRIMARY)
    await expect(controller.setWorkspaceRoots({
      sessionId: SessionId('absent'),
      additionalDirectories: [SECOND],
    })).rejects.toMatchObject({ failure: { code: 'session-not-found' } })
    await ctx.fiber.dispose()
  })
})

describe('session.workspaceOrigin', () => {
  it('reports the composed backend origin', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    ctx.provide('fs', { origin: { kind: 'network-drive' } } as never)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: PRIMARY,
    })
    expect(await remote.workspaceOrigin()).toEqual({ ok: true, value: { kind: 'network-drive' } })
    await ctx.fiber.dispose()
  })

  it('states null rather than claiming local disk when no backend is composed', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: PRIMARY,
    })
    expect(await remote.workspaceOrigin()).toEqual({ ok: true, value: null })
    await ctx.fiber.dispose()
  })

  it('routes the replacement command through the generated Remote face', async () => {
    // `create` prepares the project directory on disk, so this one goes
    // through a real temporary root rather than the fixture spellings above.
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    const extra = join(cwd, 'second')
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    // Store-backed structural factory: create builds the session with the
    // forwarded meta and registers an idle agent stub over it.
    ctx.agents.setFactory({
      createAgent: (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
        const session = ctx.sessions.create(options.sessionId, {
          ...options.meta === undefined ? {} : { meta: options.meta },
        })
        const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
        ctx.agents.register(agent)
        return Promise.resolve({ agent, dispose: () => Promise.resolve() })
      },
      resume: () => Promise.reject(new Error('resume must not run: the session stays attached')),
    })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd,
    })
    try {
      const created = await remote.create({ cwd })
      if (!created.ok) throw new Error(`session.create failed: ${created.error.message}`)
      expect(await remote.setWorkspaceRoots({
        sessionId: created.value.sessionId,
        additionalDirectories: [extra],
      })).toEqual({ ok: true, value: { additional: [extra] } })
    } finally {
      await ctx.fiber.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
