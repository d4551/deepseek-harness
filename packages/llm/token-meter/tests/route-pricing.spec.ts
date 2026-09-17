import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmImageRequestPrice, LlmImageRequestPricing, Message, StreamChunk, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { estimateContent, estimateMessage } from '../src/estimate.ts'

/** Adapter double declaring fixed per-occurrence image prices for one route. */
class PricingAdapter extends LlmAdapter {
  constructor(private readonly pricing: (model: string) => LlmImageRequestPricing | undefined) {
    super()
  }

  override imageRequestPricing(_provider: string, model: string): LlmImageRequestPricing | undefined {
    return this.pricing(model)
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('the pricing adapter double does not stream')
  }
}

const VISUAL_TOKENS = 100
const HANDLE_TEXT = 'Image handle text'

const fixedPricing: LlmImageRequestPricing = {
  priceImages: images => images.map(() => ({ visualTokens: VISUAL_TOKENS, text: HANDLE_TEXT })),
}

function imageRef(name: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${name.padEnd(8, '0')}`),
    mediaType: 'image/png',
    bytes: 2048,
    width: 800,
    height: 800,
    name,
  }
}

function imageMessage(name: string, text = 'look at this'): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text },
      { type: 'image', attachment: imageRef(name) },
    ],
    source: { kind: 'user' },
  })
}

function header(model: string): EpochHeader {
  return canonicalHeader({ config: { provider: 'mock', model } })
}

interface Harness {
  meter: TokenMeter
  session: Session
}

async function harness(pricing: (model: string) => LlmImageRequestPricing | undefined): Promise<Harness> {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  const llm = new LlmRuntime(ctx)
  llm.registerAdapter(['mock'], new PricingAdapter(pricing))
  const meter = new TokenMeter(ctx)
  return { meter, session: Session.create(SessionId('route-priced')) }
}

/** Route price of one image-bearing message under the fixed pricing double. */
function routedMessageTokens(message: Message): number {
  const imageFree = estimateMessage({
    ...message,
    content: message.content.filter(block => block.type !== 'image'),
  })
  return imageFree + VISUAL_TOKENS + estimateContent([{ type: 'text', text: HANDLE_TEXT }])
}

function appendSuccessfulCall(session: Session, value: EpochHeader, usage?: TokenUsage): void {
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: value, reason: 'initial' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: value.config.provider, model: value.config.model },
    }),
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
}

describe('route-aware image pricing', () => {
  it('prices a first multimodal request estimate with the routed visual tokens', async () => {
    const { meter, session } = await harness(() => fixedPricing)
    const message = imageMessage('photo')
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })

    const measurement = meter.measure(session)
    const expectedNode = routedMessageTokens(message)
    expect(measurement.nodes).toHaveLength(1)
    const node = measurement.nodes[0]!
    expect(node.tokens).toBe(expectedNode)
    expect(node.heuristicTokens).toBe(estimateMessage(message))
    expect(node.tokens).toBeGreaterThan(node.heuristicTokens)
    expect(measurement.baseline.kind).toBe('estimated')
    expect(measurement.surfaceTokens).toBe(expectedNode)
    expect(measurement.totalTokens).toBe(expectedNode)
  })

  it('adds a post-anchor image at its routed price on top of provider usage', async () => {
    const { meter, session } = await harness(() => fixedPricing)
    const usage: TokenUsage = { inputTokens: 5000, outputTokens: 50 }
    appendSuccessfulCall(session, header('vision'), usage)
    const before = meter.measure(session)
    expect(before.baseline).toMatchObject({ kind: 'usage', tokens: 5050 })

    const message = imageMessage('fresh')
    session.append('user/message', message, { surfaceOp: 'append' })
    const after = meter.measure(session)
    expect(after.baseline).toMatchObject({ kind: 'usage', tokens: 5050 })
    expect(after.surfaceDeltaTokens - before.surfaceDeltaTokens).toBe(routedMessageTokens(message))
    expect(after.totalTokens).toBe(5050 + after.surfaceDeltaTokens)
  })

  it('reprices the surface under the substitution pricing of a text-only route', async () => {
    const placeholder = '[image omitted for the text-only route]'
    const substitution: LlmImageRequestPricing = {
      priceImages: images => images.map(() => ({ visualTokens: 0, text: placeholder })),
    }
    const { meter, session } = await harness(model => (model === 'vision' ? fixedPricing : substitution))
    const message = imageMessage('photo')
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })

    const textOnly = meter.measure(session, header('text-only'))
    const imageFree = estimateMessage({
      ...message,
      content: message.content.filter(block => block.type !== 'image'),
    })
    expect(textOnly.nodes[0]!.tokens)
      .toBe(imageFree + estimateContent([{ type: 'text', text: placeholder }]))
    expect(textOnly.totalTokens).toBeLessThan(meter.measure(session).totalTokens)
  })

  it('keeps the fixed heuristic for routes and services that declare no pricing', async () => {
    const { meter, session } = await harness(() => undefined)
    const message = imageMessage('photo')
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    const declared = meter.measure(session)
    expect(declared.nodes[0]!.tokens).toBe(estimateMessage(message))

    const unknownRoute = meter.measure(
      session,
      canonicalHeader({ config: { provider: 'unregistered', model: 'any' } }),
    )
    expect(unknownRoute.nodes[0]!.tokens).toBe(estimateMessage(message))
  })

  it('fails loud when a route answers a mismatched occurrence count', async () => {
    const broken: LlmImageRequestPricing = { priceImages: () => [] }
    const { meter, session } = await harness(() => broken)
    session.append('user/message', imageMessage('photo'), { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    expect(() => meter.measure(session))
      .toThrow('route image pricing answered 0 prices for 1 occurrences')
  })

  it('rejects a missing occurrence even when the response length matches', async () => {
    const incomplete: LlmImageRequestPricing = {
      priceImages: images => new Array<LlmImageRequestPrice>(images.length),
    }
    const { meter, session } = await harness(() => incomplete)
    session.append('user/message', imageMessage('photo'), { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })

    expect(() => meter.measure(session)).toThrow('route image pricing omitted occurrence 0')
    expect(() => meter.measure(session)).toThrow('route image pricing omitted occurrence 0')
  })

  it('rejects extra prices beyond the requested occurrences', async () => {
    const pricing: LlmImageRequestPricing = {
      priceImages: () => [
        { visualTokens: VISUAL_TOKENS, text: HANDLE_TEXT },
        { visualTokens: VISUAL_TOKENS, text: HANDLE_TEXT },
      ],
    }
    const { meter, session } = await harness(() => pricing)
    session.append('user/message', imageMessage('photo'), { surfaceOp: 'append' })

    expect(() => meter.measure(session, header('vision')))
      .toThrow('route image pricing answered 2 prices for 1 occurrences')
  })

  it.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid visual token count %s without publishing pressure',
    async (visualTokens) => {
      let currentTokens = visualTokens
      const pricing: LlmImageRequestPricing = {
        priceImages: images => images.map(() => ({ visualTokens: currentTokens, text: HANDLE_TEXT })),
      }
      const { meter, session } = await harness(() => pricing)
      const message = imageMessage('photo')
      session.append('user/message', message, { surfaceOp: 'append' })
      session.append('request/header', { header: header('vision'), reason: 'initial' })

      expect(() => meter.measure(session))
        .toThrow('occurrence 0 requires a non-negative safe integer visual token count')
      currentTokens = VISUAL_TOKENS
      const measurement = meter.measure(session)
      expect(measurement.surfaceTokens).toBe(routedMessageTokens(message))
      expect(measurement.nodes).toEqual([{
        seq: 0,
        tokens: routedMessageTokens(message),
        heuristicTokens: estimateMessage(message),
      }])
    },
  )

  it('accepts an exact safe total including message framing and image text', async () => {
    const message = imageMessage('photo')
    const framingAndText = routedMessageTokens(message) - VISUAL_TOKENS
    const pricing: LlmImageRequestPricing = {
      priceImages: images => images.map(() => ({
        visualTokens: Number.MAX_SAFE_INTEGER - framingAndText,
        text: HANDLE_TEXT,
      })),
    }
    const { meter, session } = await harness(() => pricing)
    session.append('user/message', message, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })

    const measurement = meter.measure(session)
    expect(measurement.surfaceTokens).toBe(Number.MAX_SAFE_INTEGER)
    expect(measurement.totalTokens).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rejects overflow across individually valid image-bearing nodes', async () => {
    const pricing: LlmImageRequestPricing = {
      priceImages: images => images.map(() => ({
        visualTokens: Math.floor(Number.MAX_SAFE_INTEGER / 2),
        text: HANDLE_TEXT,
      })),
    }
    const { meter, session } = await harness(() => pricing)
    session.append('user/message', imageMessage('first'), { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    const first = meter.measure(session)
    expect(Number.isSafeInteger(first.surfaceTokens)).toBe(true)

    session.append('user/message', imageMessage('second'), { surfaceOp: 'append' })
    expect(() => meter.measure(session)).toThrow('route-priced surface exceeds the safe integer range at seq 2')
    expect(first.nodes).toHaveLength(1)
    expect(first.logRevision).toBe(2)
  })

  it('passes every image in surface order and applies its corresponding price', async () => {
    const first = imageRef('first')
    const second = imageRef('second')
    const third = imageRef('third')
    const batches: Array<readonly ImageAttachmentRef[]> = []
    const prices: readonly LlmImageRequestPrice[] = [
      { visualTokens: 11, text: 'one' },
      { visualTokens: 23, text: 'second image' },
      { visualTokens: 37, text: 'third image descriptor' },
    ]
    const pricing: LlmImageRequestPricing = {
      priceImages(images) {
        batches.push(images)
        return prices
      },
    }
    const { meter, session } = await harness(() => pricing)
    const firstMessage = createUserMessage({
      content: [{ type: 'image', attachment: first }, { type: 'image', attachment: second }],
      source: { kind: 'user' },
    })
    const textMessage = createUserMessage({
      content: [{ type: 'text', text: 'between images' }],
      source: { kind: 'user' },
    })
    const lastMessage = createUserMessage({
      content: [{ type: 'image', attachment: third }],
      source: { kind: 'user' },
    })
    session.append('user/message', firstMessage, { surfaceOp: 'append' })
    session.append('user/message', textMessage, { surfaceOp: 'append' })
    session.append('user/message', lastMessage, { surfaceOp: 'append' })
    const firstTokens = estimateMessage({ ...firstMessage, content: [] })
      + 11 + estimateContent([{ type: 'text', text: 'one' }])
      + 23 + estimateContent([{ type: 'text', text: 'second image' }])
    const lastTokens = estimateMessage({ ...lastMessage, content: [] })
      + 37 + estimateContent([{ type: 'text', text: 'third image descriptor' }])

    const measurement = meter.measure(session, header('vision'))
    expect(batches).toEqual([[first, second, third]])
    expect(measurement.nodes).toEqual([
      { seq: 0, tokens: firstTokens, heuristicTokens: estimateMessage(firstMessage) },
      { seq: 1, tokens: estimateMessage(textMessage), heuristicTokens: estimateMessage(textMessage) },
      { seq: 2, tokens: lastTokens, heuristicTokens: estimateMessage(lastMessage) },
    ])
    expect(measurement.surfaceTokens).toBe(firstTokens + estimateMessage(textMessage) + lastTokens)
  })

  it('does not invoke image pricing when the surface contains only text', async () => {
    const pricing: LlmImageRequestPricing = {
      priceImages() { throw new Error('image pricing requires an image occurrence') },
    }
    const { meter, session } = await harness(() => pricing)
    const message = createUserMessage({
      content: [{ type: 'text', text: 'text request' }],
      source: { kind: 'user' },
    })
    session.append('user/message', message, { surfaceOp: 'append' })
    const measurement = meter.measure(session, header('vision'))
    expect(measurement.surfaceTokens).toBe(estimateMessage(message))
    expect(measurement.totalTokens).toBe(estimateMessage(message))
  })

  it('prices nested tool-result images through the same route pricing', async () => {
    const { meter, session } = await harness(() => fixedPricing)
    const nested = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1' as never,
        content: [
          { type: 'text', text: 'screenshot below' },
          { type: 'image', attachment: imageRef('nested') },
        ],
      }],
      source: { kind: 'user' },
    })
    session.append('user/message', nested, { surfaceOp: 'append' })
    session.append('request/header', { header: header('vision'), reason: 'initial' })
    const measurement = meter.measure(session)
    const imageFree = estimateMessage({
      ...nested,
      content: [{
        ...nested.content[0] as Extract<Message['content'][number], { type: 'tool-result' }>,
        content: [{ type: 'text', text: 'screenshot below' }],
      }],
    })
    expect(measurement.nodes[0]!.tokens)
      .toBe(imageFree + VISUAL_TOKENS + estimateContent([{ type: 'text', text: HANDLE_TEXT }]))
  })
})
