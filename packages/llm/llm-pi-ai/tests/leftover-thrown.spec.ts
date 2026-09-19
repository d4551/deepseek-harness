import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

const LEFTOVER_VISION = 'leftover-vision'
const LEFTOVER_TEXT = 'leftover-text'

const leftoverProfiles = resolveProfiles({
  [LEFTOVER_VISION]: {
    api: 'openai-completions',
    baseURL: 'https://leftover.test/v1',
    models: [{ id: 'leftover-vision', input: ['text', 'image'] }],
  },
  [LEFTOVER_TEXT]: {
    api: 'openai-completions',
    baseURL: 'https://leftover.test/v1',
    models: [{ id: 'leftover-text' }],
  },
})

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

const leftoverImageLimits: ImageAttachmentLimits = {
  maxImageBytes: 1,
  maxImagesPerMessage: 1,
  maxMessageImageBytes: 1,
  maxImagePixels: 1,
  maxImageDimension: 2000,
  mediaTypes: ['image/png'],
}

const leftoverConversion: { value: Thrown } = { value: undefined }

const leftoverAttachments = new class extends AttachmentStore {
  readonly imageLimits = leftoverImageLimits
  constructor() {
    super(new Context())
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    throw new Error('not used')
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    throw new Error('not used')
  }

  readImage(_value: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }

  override readImageRequest(): Promise<RequestImageAttachment> {
    throw leftoverConversion.value
  }
}()

const leftoverImageAdapter = new PiAiAdapter({
  profiles: () => leftoverProfiles,
  resolveApiKey: () => Promise.resolve('test-key'),
  auth: memoryAuth(),
  resolveAttachments: () => leftoverAttachments,
})

function ownObject(target: object, key: string): object {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor === undefined) throw new Error(`${key} is not an object`)
  const holder: { value?: unknown } = {}
  Object.defineProperty(holder, 'value', descriptor)
  const value = holder.value
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new Error(`${key} is not an object`)
  }
  return value
}

function leftoverTextStart(): AssistantMessageEvent {
  return {
    type: 'text_start',
    contentIndex: 0,
    partial: {
      role: 'assistant',
      content: [],
      api: 'openai-completions',
      provider: LEFTOVER_TEXT,
      model: 'leftover-text',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 0,
    },
  }
}

function leftoverTextAdapter(iterator: AsyncIterator<AssistantMessageEvent>): PiAiAdapter {
  const adapter = new PiAiAdapter({
    profiles: () => leftoverProfiles,
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
  const info = adapter.providerInfo(LEFTOVER_TEXT)
  if (info.name !== LEFTOVER_TEXT) throw new Error('leftover text route missing')
  Object.defineProperty(ownObject(ownObject(adapter, 'snapshot'), 'models'), 'streamSimple', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () => ({ [Symbol.asyncIterator]: () => iterator }),
  })
  return adapter
}

async function drainLeftoverImage(signal?: AbortSignal): Promise<void> {
  for await (const _chunk of leftoverImageAdapter.stream({
    provider: LEFTOVER_VISION,
    model: 'leftover-vision',
    messages: [createUserMessage({
      content: [{ type: 'image', attachment: IMAGE_REF }],
      source: { kind: 'plugin', plugin: 'test' },
    })],
    ...signal === undefined ? {} : { signal },
  })) { /* drain */ }
}

async function drainLeftoverText(adapter: PiAiAdapter, signal?: AbortSignal): Promise<void> {
  for await (const _chunk of adapter.stream({
    provider: LEFTOVER_TEXT,
    model: 'leftover-text',
    messages: [],
    ...signal === undefined ? {} : { signal },
  })) { /* drain */ }
}

function leftoverThrowingAdapter(leftover: Thrown): PiAiAdapter {
  return leftoverTextAdapter({
    next: () => {
      throw leftover
    },
    return: () => Promise.resolve({ done: true, value: undefined }),
  })
}

describe('leftover Promise reject arms', () => {
  it('preserves a leftover conversion refuse that is not an Error', async () => {
    leftoverConversion.value = 'leftover conversion string'
    await expect(drainLeftoverImage()).rejects.toBe('leftover conversion string')
  })

  it('preserves a leftover undefined conversion refuse', async () => {
    leftoverConversion.value = undefined
    await expect(drainLeftoverImage()).rejects.toBeUndefined()
  })

  it('rethrows an already-classified TIMEOUT leftover stream refuse', async () => {
    const leftover = new LlmError('already classified idle timeout', 'TIMEOUT')
    const controller = new AbortController()
    controller.abort('caller also cancelled')
    await expect(drainLeftoverText(leftoverThrowingAdapter(leftover), controller.signal)).rejects.toBe(leftover)
  })

  it('rethrows an already-classified ABORTED leftover stream refuse', async () => {
    const leftover = new LlmError('already classified abort', 'ABORTED')
    const controller = new AbortController()
    controller.abort('caller cancelled')
    await expect(drainLeftoverText(leftoverThrowingAdapter(leftover), controller.signal)).rejects.toBe(leftover)
  })

  it('preserves a leftover stream iterator refuse', async () => {
    await expect(drainLeftoverText(leftoverThrowingAdapter('leftover stream reject')))
      .rejects.toBe('leftover stream reject')
  })

  it('contains a leftover SDK teardown refuse when the consumer stops early', async () => {
    const adapter = leftoverTextAdapter({
      next: () => Promise.resolve({ done: false, value: leftoverTextStart() }),
      return: () => {
        throw 'leftover sdk teardown'
      },
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: LEFTOVER_TEXT,
      model: 'leftover-text',
      messages: [],
    })) {
      chunks.push(chunk)
      if (chunk.type === 'block-start') break
    }
    expect(chunks).toEqual([{ type: 'block-start', index: 0, blockType: 'text' }])
  })
})
