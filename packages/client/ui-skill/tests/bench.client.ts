/**
 * Bench for the skill catalog specs: fake slash, connection, session,
 * presentation, and locale faces around the real plugin, the catalog
 * fixtures, and bound views of the source's optional hooks so a spec never
 * reaches for a possibly absent method. The browser-plugin spec keeps its own
 * presentation registry because it asserts what the plugin registers there.
 */
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject } from '../src/client/index.ts'

export type SkillRow = { name: string; description: string; whenToUse?: string; modelInvocable?: boolean }
export type ListResult =
  | { ok: true; value: { skills: SkillRow[] } }
  | { ok: false; error: { code: string; message: string; details: object } }
export type ListFn = (payload: object, signal?: AbortSignal) => Promise<ListResult>

type SubscribeLexicon = NonNullable<InputTriggerSource['subscribeLexicon']>
type LexiconListener = Parameters<SubscribeLexicon>[1]
type LexiconDisposer = ReturnType<SubscribeLexicon>

/** Boot the plugin over fake faces; returns the captured slash source, its ctx, and the remote. */
export async function bench(list: ListFn, addressed?: SessionId): Promise<{
  ctx: Context
  source: InputTriggerSource
  remote: TestRemote
}> {
  const ctx = new Context()
  let captured: InputTriggerSource | undefined
  ctx.provide('inputTriggers', { registerSource: (src: InputTriggerSource) => { captured = src; return () => {} } })
  ctx.provide('connection', {})
  ctx.provide('sessions', {
    subagentAddress: (id: SessionId) => id === addressed
      ? { parentSessionId: sid('parent'), childSessionId: id, mode: 'continuable' as const }
      : undefined,
  })
  ctx.provide('slots', {
    inject: (_name: string, callback: () => () => undefined) => callback(),
    register: () => () => {},
  })
  ctx.provide('locale', {
    register: () => () => {},
    // Minimal bound-translate fake: zh dictionary lookup, key passthrough on miss.
    bind: () => (key: string) => key === 'menu.userOnly' ? '仅用户' : key,
  })
  const remote = new TestRemote(ctx, { skills: { list } })
  await ctx.plugin({ inject: [...inject], apply }).await()
  if (captured === undefined) throw new Error('the skill plugin registered no slash source')
  return { ctx, source: captured, remote }
}

/** The source's optional hooks, bound and present, or a loud failure naming the absent one. */
export function lexiconHooks(source: InputTriggerSource): {
  lexicon: (session: ClientSessionContext) => readonly string[] | undefined
  subscribeLexicon: (session: ClientSessionContext, listener: LexiconListener) => LexiconDisposer
  warm: (session: ClientSessionContext) => undefined
} {
  const missing = (name: string): never => {
    throw new Error(`the skill source registered without ${name}`)
  }
  return {
    lexicon: session => source.lexicon === undefined ? missing('lexicon') : source.lexicon(session),
    subscribeLexicon: (session, listener) =>
      source.subscribeLexicon === undefined ? missing('subscribeLexicon') : source.subscribeLexicon(session, listener),
    warm: (session) => {
      if (source.warm === undefined) missing('warm')
      else source.warm(session)
      return undefined
    },
  }
}

export const CATALOG: SkillRow[] = [
  { name: 'commit-helper', description: 'commit flow', modelInvocable: true },
  { name: 'code-review', description: 'review flow', whenToUse: 'reviews', modelInvocable: true },
  { name: 'deploy', description: 'deploy flow', modelInvocable: true },
]

export const listOk = (skills: SkillRow[]): ListFn => () => Promise.resolve({ ok: true as const, value: { skills } })

export const sid = (id: string): SessionId => id as SessionId

export const proj = (id: string): ClientSessionContext => ({ sessionId: sid(id) })

export const req = (query: string, signal?: AbortSignal): {
  query: string
  position: 'leading'
  drilled: boolean
  signal: AbortSignal
} => ({ query, position: 'leading', drilled: false, signal: signal ?? new AbortController().signal })
