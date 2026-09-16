// The Tool-owned keyed-slot type chain: registration shape and composed
// atomic-view props. Generic slot-system duals live in ui-slots tests.
import { describe, expectTypeOf, it } from 'vitest'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ToolCallViewProps } from '../src/client/contract/slots.ts'

describe('Tool view type chain', () => {
  it('requires a keyed registration and keeps conversation data out of atomic views', () => {
    type ToolRegistration = Parameters<typeof SlotRegistry.prototype.register<'tool.call.toolview'>>[0]
    expectTypeOf<{ name: 'tool.call.toolview' }>().not.toExtend<ToolRegistration>()
    expectTypeOf<ToolRegistration>().not.toHaveProperty('id')
    expectTypeOf<ToolRegistration>().not.toHaveProperty('order')
    expectTypeOf<ToolRegistration>().toHaveProperty('key').toEqualTypeOf<string>()
    expectTypeOf<ToolCallViewProps>().not.toHaveProperty('loadOlder')
    expectTypeOf<ToolCallViewProps['block']>().not.toHaveProperty('argsParsed')
  })
})
