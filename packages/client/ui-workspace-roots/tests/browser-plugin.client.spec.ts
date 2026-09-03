/**
 * ui-workspace-roots plugin halves: the browser entry's dictionary and
 * header-slot registrations against the real SlotRegistry (with fiber teardown
 * proving removal — HMR safety), the injected actions it hands each render
 * occurrence, the inert node entry, and the invariant companion's ownership
 * reservation.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { WorkspaceRootsInjected } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import * as RootsInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

const SESSION = 'roots-session' as SessionId

/** One recorded Remote or chooser call the browser entry made. */
type RootsCall =
  | { method: 'setWorkspaceRoots'; request: { sessionId: SessionId; additionalDirectories: string[] } }
  | { method: 'workspaceOrigin' }
  | { method: 'pickDirectory' }

/** Slot ledger reader: entry ids currently registered in the header list. */
function headerEntryIds(ctx: Context): (string | undefined)[] {
  return ctx.slots
    .entries('conversation.session.header.actions')
    .map(entry => entry.options.id)
}

/** Boot the browser half over a real slot tree that declares the header list. */
async function bench(): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  calls: RootsCall[]
}> {
  const calls: RootsCall[] = []
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  // Held so the service registration outlives this call; the nested namespace
  // below is what the plugin actually reads.
  const remote = new RemoteService(ctx)
  expect(remote).toBeInstanceOf(Service)
  ctx.provide('remote.session', {
    setWorkspaceRoots: (request: { sessionId: SessionId; additionalDirectories: string[] }) => {
      calls.push({ method: 'setWorkspaceRoots', request })
      return Promise.resolve({ ok: true, value: { additional: request.additionalDirectories } })
    },
    workspaceOrigin: () => {
      calls.push({ method: 'workspaceOrigin' })
      return Promise.resolve({ ok: true, value: { kind: 'local' } })
    },
  })
  ctx.provide('uiWorkspace', {
    pickDirectory: () => {
      calls.push({ method: 'pickDirectory' })
      return Promise.resolve('/chosen')
    },
  } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy. There is no jsdom `window` in
  // this lane, so browser-language detection never runs and the locale comes
  // from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, calls }
}

/** The injected face this occurrence hands the component. */
function injected(ctx: Context): WorkspaceRootsInjected {
  const entry = ctx.slots
    .entries('conversation.session.header.actions')
    .find(candidate => candidate.options.id === 'workspace-roots')
  const face = entry?.inject?.() as WorkspaceRootsInjected | undefined
  if (face === undefined) throw new Error('workspace-roots inject face is missing from the header slot')
  return face
}

describe('ui-workspace-roots browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'uiWorkspace'])
  })

  it('registers the header action, and fiber teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(headerEntryIds(ctx)).toContain('workspace-roots')
    await fiber.dispose()
    expect(headerEntryIds(ctx)).not.toContain('workspace-roots')
  })

  it('sends the replacement set through the Session Remote', async () => {
    const { ctx, calls } = await bench()
    const result = await injected(ctx).setRoots(SESSION, ['/a', '/b'])
    expect(calls).toEqual([{
      method: 'setWorkspaceRoots',
      request: { sessionId: SESSION, additionalDirectories: ['/a', '/b'] },
    }])
    expect(result).toEqual({ ok: true, value: { additional: ['/a', '/b'] } })
  })

  it('reads the workspace origin through the Session Remote', async () => {
    const { ctx, calls } = await bench()
    expect(await injected(ctx).loadOrigin()).toEqual({ ok: true, value: { kind: 'local' } })
    expect(calls).toEqual([{ method: 'workspaceOrigin' }])
  })

  it('delegates directory choosing to the workspace capability', async () => {
    const { ctx, calls } = await bench()
    expect(await injected(ctx).pickDirectory()).toBe('/chosen')
    expect(calls).toEqual([{ method: 'pickDirectory' }])
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('list.aria')).toBe(zh['list.aria'])
    ctx.locale.setLocale('en')
    expect(translate('list.aria')).toBe(en['list.aria'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('list.aria')).not.toBe(en['list.aria'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-workspace-roots node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})

describe('ui-workspace-roots invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(RootsInvariant)
    await fiber.await()
    expect(RootsInvariant.name).toBe('client-ui-workspace-roots-invariant')
    expect(RootsInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => {
      Reflect.apply(ctx.emit.bind(ctx), undefined, ['unrelated/event'])
    }).not.toThrow()
    await fiber.dispose()
  })
})
