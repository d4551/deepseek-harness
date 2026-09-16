import { describe, expectTypeOf, it } from 'vitest'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'

describe('Chat View type chain', () => {
  it('keeps Chat injection and store props out of the target-neutral base', () => {
    expectTypeOf<ConvViewProps>().not.toHaveProperty('openDetails')
    expectTypeOf<'nope'>().not.toExtend<Parameters<ChatViewSlotProps['openDetails']>[0]>()
    expectTypeOf<{ turnSeq: number; callId: string }>()
      .not.toExtend<Parameters<ChatViewSlotProps['openFile']>[0]>()
    expectTypeOf<ChatViewSlotProps['openFile']>().parameter(0).toEqualTypeOf<string>()
  })
})
