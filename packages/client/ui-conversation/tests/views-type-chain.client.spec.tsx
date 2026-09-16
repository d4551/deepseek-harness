// Target-neutral View-ring type chain and runtime ledger projection.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConvViewProps } from '../src/client/contract/slots.ts'

describe('Conversation view type chain', () => {
  it('requires list identity and rejects unsupplied component props', () => {
    type ViewRegistration = Parameters<typeof SlotRegistry.prototype.register<'conversation.view'>>
    expectTypeOf<{ name: 'conversation.view'; order: number }>().not.toExtend<ViewRegistration[0]>()
    expectTypeOf<ViewRegistration[0]>().toHaveProperty('id').toEqualTypeOf<string>()
    expectTypeOf<ViewRegistration[0]>().not.toHaveProperty('key')
    expectTypeOf<(props: ConvViewProps & { phantom: number }) => null>()
      .not.toExtend<ViewRegistration[1]>()
    expectTypeOf<ConvViewProps>().not.toHaveProperty('renderSlot')
  })
})

describe('view-ring runtime dual (real ledger)', () => {
  function bench() {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const slots = new SlotRegistry(ctx)
    // The conversation entry's role: declare the ring (declaring is claiming).
    slots.register({
      name: 'root',
      children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    }, (_p: { renderSlot?: unknown }) => null)
    return { slots }
  }

  it('registers, orders, projects tabs, and disposes through the slot ledger', () => {
    const { slots } = bench()
    const offLate = slots.register(
      { name: 'conversation.view', id: 'z-late', order: 20, label: '晚' }, () => null)
    const offEarly = slots.register(
      { name: 'conversation.view', id: 'early', order: 0, label: '早' }, () => null)
    // Order-sorted ledger, label fallback for a labelless rider.
    const offBare = slots.register(
      { name: 'conversation.view', id: 'bare', order: 10 }, () => null)
    const tabs = slots.entries('conversation.view')
      .map(e => ({ id: e.options.id, label: e.options.label ?? e.options.id }))
    expect(tabs).toEqual([
      { id: 'early', label: '早' },
      { id: 'bare', label: 'bare' },
      { id: 'z-late', label: '晚' },
    ])
    // Duplicate ids fail loud at load (the ring's uniqueness contract).
    expect(() => slots.register({ name: 'conversation.view', id: 'early' }, () => null))
      .toThrow(/already has an entry with id "early"/)
    offEarly()
    expect(slots.entries('conversation.view').map(e => e.options.id)).toEqual(['bare', 'z-late'])
    offBare()
    offLate()
    expect(slots.entries('conversation.view')).toHaveLength(0)
  })
})
