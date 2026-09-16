import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { createMessage, createUserMessage, prepareRequestImages, resolveImageAttachmentAccess, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { serializeRequestWithImages } from '../../llm-deepseek/src/serialize.ts'
import { toPiContext } from '../src/context.ts'

const policy = { maxPixels: 640_000, maxBytes: 1024 * 1024 }
const referenceChanges: { field: string; change: (ref: ImageAttachmentRef) => Partial<ImageAttachmentRef> }[] = [
  { field: 'bytes', change: ref => ({ bytes: ref.bytes + 1 }) },
  { field: 'width', change: ref => ({ width: ref.width + 1 }) },
  { field: 'height', change: ref => ({ height: ref.height + 1 }) },
  { field: 'mediaType', change: () => ({ mediaType: 'image/jpeg' }) },
]

async function imageStore() {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-provider-image-integrity-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  const ref = await ctx.attachments.saveImage({
    data: await readFile(new URL('./fixtures/qr-code.png', import.meta.url)),
    mediaType: 'image/png',
    name: 'first.png',
  })
  const imagePath = ctx.attachments.imageHostPath(ref)
  if (imagePath === undefined) throw new Error('The local attachment has no filesystem path.')
  return { ctx, dshHome, ref, imagePath }
}

async function deepSeek(ctx: Context, dshHome: string, maxImagesPerRequest = 600) {
  await ctx.plugin(LocalCredentialProvider, { path: join(dshHome, '.credentials.yaml'), watch: false })
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  const key = credentialRef('REQUEST_IMAGE_INTEGRITY_KEY')
  await ctx.credentials.set(key, 'local-image-verification')
  const connection = resolveAdapterOptions({
    baseURL: 'http://127.0.0.1:1',
    apiKeyEnv: key,
    models: [{ id: 'vision', inputModalities: ['text', 'image'] }],
    maxImagesPerRequest,
    imageOffloadCountQuantum: 1,
  })
  return new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async (connection) => {
      const credential = await ctx.credentials.resolve(connection.apiKeyEnv)
      if (credential === undefined) throw new Error('The stored test credential is missing.')
      return credential.value
    },
    resolveUserId: () => getOrCreateAnonymousUserId({ env: { DSH_HOME: dshHome } }),
    resolveAttachments: () => ctx.attachments,
    prepareExtensions: request => ctx.deepseekLlmApiExtensions.prepare(request),
  })
}

function request(messages: Message[]): GenerateOptions {
  return { provider: 'deepseek-official', model: 'vision', messages }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function occurrences(refs: ImageAttachmentRef[]): Message[] {
  return [createUserMessage({
    source: { kind: 'user' },
    content: refs.map(attachment => ({ type: 'image', attachment })),
  })]
}

describe('provider request-image integrity', () => {
  for (const invalidFirst of [true, false]) {
    it.each(referenceChanges)(`pi-ai verifies $field when invalid-first is ${invalidFirst}`, async ({ change }) => {
      const { ctx, ref } = await imageStore()
      const invalid = { ...ref, ...change(ref) }
      const refs = invalidFirst ? [invalid, ref] : [ref, invalid]
      await expect(toPiContext(request(occurrences(refs)), {
        attachments: ctx.attachments,
        resolveImageAccess: ref => resolveImageAttachmentAccess(ctx.attachments, path => path, ref),
      })).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
      await expect(ctx.attachments.readImage(ref)).resolves.toMatchObject({ ref })
    })

    it.each(referenceChanges)(`DeepSeek verifies $field when invalid-first is ${invalidFirst}`, async ({ change }) => {
      const { ctx, dshHome, ref } = await imageStore()
      const invalid = { ...ref, ...change(ref) }
      const adapter = await deepSeek(ctx, dshHome)
      const refs = invalidFirst ? [invalid, ref] : [ref, invalid]
      await expect(collect(adapter.stream(request(occurrences(refs))))).rejects.toMatchObject({
        code: 'TRANSPORT',
        cause: { code: 'ATTACHMENT_CORRUPT' },
      })
      await expect(ctx.attachments.readImage(ref)).resolves.toMatchObject({ ref })
    })
  }

  it('verifies a conflicting nested reference before a later valid occurrence', async () => {
    const { ctx, dshHome, ref } = await imageStore()
    const messages = [createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'tool-result', toolCallId: ToolCallId('image-read'), content: [
          { type: 'tool-result', toolCallId: ToolCallId('nested-image-read'), content: [
            { type: 'image', attachment: { ...ref, width: ref.width + 1 } },
          ] },
        ] },
        { type: 'image', attachment: ref },
      ],
    })]
    await expect(toPiContext(request(messages), {
      attachments: ctx.attachments,
      resolveImageAccess: ref => resolveImageAttachmentAccess(ctx.attachments, path => path, ref),
    })).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    const adapter = await deepSeek(ctx, dshHome)
    await expect(collect(adapter.stream(request(messages)))).rejects.toMatchObject({
      cause: { code: 'ATTACHMENT_CORRUPT' },
    })
  })

  it('retains verified bytes for repeated occurrences after the original is removed', async () => {
    const { ctx, ref, imagePath } = await imageStore()
    const renamed = { ...ref, name: 'second.png' }
    const messages = occurrences([ref, { ...ref }, renamed])
    const versions = await prepareRequestImages(messages, ctx.attachments, policy)
    expect(versions.size).toBe(1)
    const version = versions.get(ref.attachmentId)
    if (version === undefined) throw new Error('The verified image was not returned.')
    const pi = await toPiContext(request(messages), {
      attachments: ctx.attachments,
      resolveImageAccess: ref => resolveImageAttachmentAccess(ctx.attachments, path => path, ref),
    })
    expect(JSON.stringify(pi)).toContain('first.png')
    expect(JSON.stringify(pi)).toContain('second.png')
    const encoded = Buffer.from(version.data).toString('base64')
    expect(JSON.stringify(pi).split(encoded)).toHaveLength(4)
    await rm(imagePath)
    const wire = await serializeRequestWithImages(request(messages), {
      representation: { kind: 'base64' },
      requestImages: versions,
      maxRequestImageBytes: 20 * 1024 * 1024,
    })
    expect(JSON.stringify(wire).split(encoded)).toHaveLength(4)
    expect(JSON.stringify(wire)).toContain('first.png')
    expect(JSON.stringify(wire)).toContain('second.png')
    await expect(prepareRequestImages(messages, ctx.attachments, policy)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  })

  const unsupportedRoles: Message['role'][] = ['system', 'assistant']
  for (const role of unsupportedRoles) {
    it(`DeepSeek denies an unsupported ${role} image before image-count offload`, async () => {
      const { ctx, dshHome, ref, imagePath } = await imageStore()
      const messages = [
        createMessage({ role, source: { kind: 'plugin', plugin: 'image-integrity' }, content: [{ type: 'image', attachment: ref }] }),
        ...occurrences([ref]),
      ]
      await rm(imagePath)
      const adapter = await deepSeek(ctx, dshHome, 1)
      await expect(collect(adapter.stream(request(messages)))).rejects.toMatchObject({
        code: 'UNSUPPORTED_CONTENT',
        message: `The DeepSeek chat-completions adapter cannot represent image content in a ${role} message.`,
      })
    })
  }

  it('honors cancellation before starting preparation', async () => {
    const { ctx, ref } = await imageStore()
    const reason = new Error('Image request cancelled.')
    await expect(prepareRequestImages(occurrences([ref]), ctx.attachments, policy, AbortSignal.abort(reason))).rejects.toBe(reason)
    await expect(ctx.attachments.readImage(ref)).resolves.toMatchObject({ ref })
  })
})
