import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeTypescriptFile } from '../../../../scripts/typescript-semantics.ts'

const declarations = `
import { expectTypeOf } from 'vitest'
import type { ReactNode } from 'react'
import type {
  BoundActions, DefineStore, PropsRenderSlots, PropsRuntime, PropsStore, SlotHookFactory,
} from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
export { expectTypeOf }
export interface Item { kind: 'q' | 'a'; id: string }
export interface TurnDataMap { tail: string; files: string }
export type UseTurnData = <Key extends keyof TurnDataMap>(key: Key) => TurnDataMap[Key] | undefined
export interface ContextInjected { hooks: { turnData: SlotHookFactory<'chain.context', UseTurnData> } }
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'chain.frame': { kind: 'single'; scope: 'root' }
    'chain.side': { kind: 'single'; scope: 'root'; owner: { collapsed: boolean; width: number } }
    'chain.conv': { kind: 'single'; scope: 'session' }
    'chain.context': { kind: 'single'; scope: 'session'; hookContext: string; inject: ContextInjected }
    'chain.tools': { kind: 'keyed'; scope: 'session' }
    'chain.takeover': { kind: 'chain'; scope: 'session'; owner: { items: readonly Item[] } }
  }
}
export declare const defineStore: DefineStore
export function createPanelStore() {
  return defineStore({
    init: () => ({ sidebar: 280, details: 0 }),
    persist: 'test.panels',
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = px },
      setDetails: (d, px: number) => { d.details = px },
    },
  })
}
export function createChatStore() {
  return defineStore({
    init: (): { selection: { id: string } | null; draft: string } => ({ selection: null, draft: '' }),
    actions: {
      select: (d, t: { id: string }) => { d.selection = t },
      setDraft: (d, text: string) => { d.draft = text },
      clearDraft: (d) => { d.draft = '' },
    },
  })
}
export type ChatHandle = ReturnType<typeof createChatStore>
export type FrameProps = PropsRuntime<'chain.frame'> & PropsRenderSlots<'chain.side' | 'chain.conv'>
  & PropsStore<ReturnType<typeof createPanelStore>> & { openSettings: () => void }
export type ConvProps = PropsRuntime<'chain.conv'> & PropsStore<ChatHandle> & { send: (t: string) => void }
export type ContextProps = PropsRuntime<'chain.context'>
export const CONTEXT_INJECT: ContextInjected = {
  hooks: { turnData: (_standard, hookContext) => {
    expectTypeOf(hookContext).toEqualTypeOf<string>()
    return key => hookContext === '' ? undefined : ({ tail: 'tail', files: 'files' })[key]
  } },
}
export declare function Frame(props: FrameProps): ReactNode
export declare function Conv(props: ConvProps): ReactNode
export declare function Details(props: PropsRuntime<'chain.conv'> & PropsStore<ChatHandle>): ReactNode
export declare function Tool(props: PropsRuntime<'chain.tools'>): ReactNode
export declare function Over(props: PropsRuntime<'chain.frame'> & PropsRenderSlots<'chain.side' | 'chain.conv'>): ReactNode
export declare function NoDecl(props: PropsRuntime<'chain.frame'> & PropsRenderSlots<'chain.side'>): ReactNode
export declare function Blind(props: PropsRuntime<'chain.frame'>): ReactNode
export declare function WrongStore(props: PropsRuntime<'chain.conv'> & PropsStore<ReturnType<typeof createPanelStore>>): ReactNode
export declare function Needs(props: PropsRuntime<'chain.conv'> & { send: (t: string) => void }): ReactNode
export declare function ContextOwner(props: PropsRuntime<'chain.frame'> & PropsRenderSlots<'chain.context'>): ReactNode
export declare function ContextReader(props: ContextProps): ReactNode
export declare function Takeover(props: PropsRuntime<'chain.takeover'> & { matched: Item }): ReactNode
export declare function WideTakeover(props: PropsRuntime<'chain.takeover'> & { matched: Item | string }): ReactNode
export declare function NarrowTakeover(props: PropsRuntime<'chain.takeover'> & { matched: { kind: 'q'; id: string; extra: number } }): ReactNode
export declare function Side(props: PropsRuntime<'chain.side'> & { x: string }): ReactNode
export declare const core: SlotCore
export declare const chat: ChatHandle
export declare const fp: FrameProps
export declare const cp: ConvProps
export declare const acts: BoundActions<ChatHandle>
export declare const chainSlots: PropsRenderSlots<'chain.takeover' | 'chain.conv'>
export declare const contextProps: ContextProps
export declare const contextSlots: PropsRenderSlots<'chain.context'>
export declare const sideOnly: PropsRenderSlots<'chain.side'>
`

const positiveChain = `
core.register({
  name: 'chain.frame',
  children: {
    'chain.side': { kind: 'single', scope: 'root' },
    'chain.conv': { kind: 'single', scope: 'session' },
  },
  store: createPanelStore,
  inject: (actions) => {
    actions.setSidebar(0)
    return { openSettings: () => actions.setDetails(1) }
  },
}, Frame)
core.register({
  name: 'chain.conv', store: chat,
  inject: (sessionId, actions) => ({ send: (text: string) => {
    expectTypeOf(sessionId).toExtend<string>()
    actions.setDraft(text)
  } }),
}, Conv)
core.register({ name: 'chain.conv', store: chat }, Details)
fp.renderSlot('chain.side', { collapsed: false, width: 280 })
expectTypeOf(cp.useStore(s => s.draft)).toEqualTypeOf<string>()
cp.actions.select({ id: 'm1' })
core.register({ name: 'chain.tools', key: 'bash' }, Tool)
core.register({
  name: 'chain.takeover', select: ({ items }) => items.find(i => i.kind === 'q') ?? null, priority: 1,
}, Takeover)
core.register({
  name: 'chain.takeover', select: ({ items }) => items.find(i => i.kind === 'q') ?? null,
}, WideTakeover)
chainSlots.renderSlotChain('chain.takeover', { items: [] }, { fallback: null })
chainSlots.renderSlot('chain.conv', {})
core.register({ name: 'chain.frame', children: {
  'chain.context': { kind: 'single', scope: 'session', inject: CONTEXT_INJECT },
} }, ContextOwner)
core.register({ name: 'chain.context' }, ContextReader)
expectTypeOf(contextProps.useTurnData('tail')).toEqualTypeOf<string | undefined>()
contextSlots.renderSlot('chain.context', {}, { hookContext: 'turn:1' })
acts.setDraft('x')
fp.SessionProvider({ empty: () => null, children: null })
`

const rejectedCalls = [
  ['child scope matches SlotMap', 2322,
    "core.register({ name: 'chain.frame', children: { 'chain.conv': { kind: 'single', scope: 'root' } } }, Blind)"],
  ['contextual child requires common injection', 2322,
    "core.register({ name: 'chain.frame', children: { 'chain.context': { kind: 'single', scope: 'session' } } }, ContextOwner)"],
  ['component cannot widen declared children', 2345,
    "core.register({ name: 'chain.frame', children: { 'chain.side': { kind: 'single', scope: 'root' } } }, Over)"],
  ['render consumption requires children', 2345,
    "core.register({ name: 'chain.frame' }, NoDecl)"],
  ['declared children must be consumed', 2345,
    "core.register({ name: 'chain.frame', children: { 'chain.side': { kind: 'single', scope: 'root' } } }, Blind)"],
  ['component cannot infer a different store', 2345,
    "core.register({ name: 'chain.conv', store: chat }, WrongStore)"],
  ['injection must provide business props', 2345,
    "core.register({ name: 'chain.conv', inject: () => ({ notSend: 1 }) }, Needs)"],
  ['business props require injection', 2345,
    "core.register({ name: 'chain.conv' }, Needs)"],
  ['root injection has no session parameter', 2322,
    "core.register({ name: 'chain.side', inject: (sessionId: string) => ({ x: sessionId }) }, Side)"],
  ['keyed entries require a key', 2345,
    "core.register({ name: 'chain.tools' }, Tool)"],
  ['chain entries require a selector', 2345,
    "core.register({ name: 'chain.takeover' }, Takeover)"],
  ['component cannot change selector inference', 2345,
    "core.register({ name: 'chain.takeover', select: ({ items }: { items: readonly Item[] }) => items.find(i => i.kind === 'q') ?? null }, NarrowTakeover)"],
  ['selector cannot include undefined', 2345,
    "core.register({ name: 'chain.takeover', select: ({ items }: { items: readonly Item[] }) => items.find(i => i.kind === 'q') }, Takeover)"],
  ['chain slots use chain dispatch', 2345,
    "chainSlots.renderSlot('chain.takeover', { items: [] })"],
  ['ordinary slots use ordinary dispatch', 2345,
    "chainSlots.renderSlotChain('chain.conv', {})"],
  ['ordinary child sets have no chain seat', 2551,
    'export type NoChainSeat = typeof fp.renderSlotChain'],
  ['owner share requires width', 2345,
    "fp.renderSlot('chain.side', { collapsed: false })"],
  ['render keys stay within the declared share', 2345,
    "fp.renderSlot('chain.tools', {})"],
  ['contextual hooks preserve their key domain', 2345,
    "contextProps.useTurnData('other')"],
  ['contextual dispatch requires occurrence context', 2554,
    "contextSlots.renderSlot('chain.context', {})"],
  ['context factories preserve context type', 2322,
    "export const wrongContextFactory: SlotHookFactory<'chain.context', UseTurnData> = (_standard, _hookContext: number) => () => undefined"],
  ['baked actions retain payload type', 2345, 'acts.setDraft(1)'],
  ['root-only children have no session provider', 2339,
    'export type NoSessionProvider = typeof sideOnly.SessionProvider'],
] satisfies readonly (readonly [string, number, string])[]

function checkConsumer(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-slot-types-'))
  const repository = resolve(import.meta.dirname, '../../../..')
  try {
    const modules = join(directory, 'node_modules')
    mkdirSync(join(modules, '@types'), { recursive: true })
    symlinkSync(join(repository, 'node_modules/vitest'), join(modules, 'vitest'), 'junction')
    symlinkSync(join(import.meta.dirname, '../node_modules/@types/react'), join(modules, '@types/react'), 'junction')
    const sourceFile = join(directory, 'consumer.ts')
    const configFile = join(directory, 'tsconfig.json')
    writeFileSync(configFile, JSON.stringify({
      extends: join(repository, 'tsconfig.base.client.json'),
      compilerOptions: { noEmit: true, composite: false, incremental: false, types: ['node'] },
      files: ['consumer.ts'],
    }))
    writeFileSync(sourceFile, `${declarations}\n${body}\n`)
    return { ...analyzeTypescriptFile(configFile, sourceFile), bodyStart: declarations.length + 1 }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('slot registration type inference', () => {
  it('compiles the complete positive chain against the actual source contracts', () => {
    expect(checkConsumer(positiveChain).diagnostics).toEqual([])
  })

  it.each(rejectedCalls)('%s', (_obligation, code, source) => {
    const report = checkConsumer(source)
    expect(report.diagnostics).toHaveLength(1)
    const diagnostic = report.diagnostics[0]
    expect(diagnostic).toMatchObject({ code, category: 1, fileName: report.file })
    expect(diagnostic?.pos).toBeGreaterThanOrEqual(report.bodyStart)
    expect(diagnostic?.end).toBeLessThanOrEqual(report.bodyStart + source.length)
  })
})
