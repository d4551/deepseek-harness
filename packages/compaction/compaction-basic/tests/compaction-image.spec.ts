import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/selection.ts'
import { frameSummary } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import {
  MODEL,
  agent,
  compactIfNeeded,
  createContext,
  service,
} from './harness.ts'

const IMAGE_VISUAL_TOKENS = 300
const IMAGE_HANDLE_TEXT = 'request preview'

/** A model service pricing each image occurrence at a fixed visual-token count. */
class PricedImageModelService extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000 },
    })
  }

  override imageRequestPricing(): { priceImages: (images: readonly never[]) => Array<{ visualTokens: number; text: string }> } {
    return {
      priceImages: images => images.map(() => ({
        visualTokens: IMAGE_VISUAL_TOKENS,
        text: IMAGE_HANDLE_TEXT,
      })),
    }
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function pricedContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter([MODEL], new PricedImageModelService())
  return ctx
}

/** Closed short-text turns whose user messages each carry one image. */
function imageConversation(turns = 4): Session {
  const session = Session.create(SessionId(`image-dense-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: `image turn ${turn}` },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId(`sha256:${String(turn).repeat(8)}`),
            mediaType: 'image/png',
            bytes: 2048,
            width: 800,
            height: 800,
            name: `shot-${turn}`,
          },
        },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `ok ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

describe('route-priced image pressure', () => {
  it('selects an image-dense range only when the routed price counts visual tokens', async () => {
    const session = imageConversation()
    const routed = (await pricedContext()).tokenMeter.measure(session)
    const neutral = (await createContext()).tokenMeter.measure(session)

    expect(routed.surfaceTokens).toBeGreaterThan(neutral.surfaceTokens + 4 * IMAGE_VISUAL_TOKENS - 200)
    expect(routed.nodes.map(node => node.seq)).toEqual(neutral.nodes.map(node => node.seq))
    expect(routed.nodes.map(node => node.heuristicTokens)).toEqual(neutral.nodes.map(node => node.tokens))

    // The same verbatim tail budget retains almost everything under the
    // neutral heuristic but forces a cut once visual tokens are counted.
    expect(selectCompactableRange(session, neutral, 350).kind).toBe('none')
    const range = selectCompactableRange(session, routed, 350)
    expect(range.kind).toBe('range')
  })

  it('accepts a summary larger than the span heuristic when the route price shrinks', async () => {
    // A single short image message prices below a framed summary under the
    // fixed heuristic but far above it under the route: the shrink comparison
    // must ask whether the replacement lowers route pressure.
    const ctx = await pricedContext()
    const session = imageConversation(1)
    const before = ctx.tokenMeter.measure(session)
    const imageNode = before.nodes[0]
    if (imageNode === undefined) throw new Error('fixture surface empty')
    const compact = await service({ auto: false }, ctx)
    compact.summary = [{
      type: 'text',
      text: 'summary text sized between the heuristic and route prices of the shadowed image message, '
        + 'long enough that the fixed heuristic alone would reject it as not smaller '
        + 'while the route-priced comparison accepts the pressure reduction.',
    }]
    const framed = ctx.tokenMeter.estimateMessage(createUserMessage({
      content: frameSummary(compact.summary),
      source: { kind: 'plugin', plugin: 'test' },
    }))
    expect(framed).toBeGreaterThan(imageNode.heuristicTokens)
    expect(framed).toBeLessThan(imageNode.tokens)

    const result = await compact.compactRegion(imageNode.seq, imageNode.seq, agent(session), new AbortController().signal)
    expect(result.shadowedSeqs).toEqual([imageNode.seq])
    expect(result.shadowedTokenCount).toBe(imageNode.heuristicTokens)
  })

  it('triggers pressure compaction from routed visual tokens and logs heuristic shadow prices', async () => {
    const ctx = await pricedContext()
    const session = imageConversation()
    const before = ctx.tokenMeter.measure(session)
    const compact = await service({
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 350,
    }, ctx)

    // The same history stays below the 800-token threshold without pricing.
    const neutralResult = await compactIfNeeded(await service({
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 350,
    }), session)
    expect(neutralResult).toEqual(null)

    const result = await compact.compactIfNeeded(agent(session), 'pressure', new AbortController().signal)
    expect(result).not.toBeNull()
    const summaryEvent = session.events.find(event => event.type === 'compaction/summary')
    const shadowedHeuristic = before.nodes
      .filter(node => result?.shadowedSeqs.includes(node.seq))
      .reduce((total, node) => total + node.heuristicTokens, 0)
    expect(summaryEvent?.data.shadowedTokenCount).toBe(shadowedHeuristic)
  })
})
