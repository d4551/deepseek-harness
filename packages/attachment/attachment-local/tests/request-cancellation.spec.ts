import { getEventListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import LocalAttachmentStore from '../src/index.ts'
import { requestImageVariantId } from '../src/request-image.ts'

const policy = { maxPixels: 64, maxBytes: 1024 }

async function source(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png().toBuffer()
}

it('honors cancellation despite an earlier listener stopping event propagation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-request-propagation-'))
  try {
    const store = new LocalAttachmentStore(new Context(), { dshHome: home })
    const ref = await store.saveImage({ data: await source(), mediaType: 'image/png' })
    const controller = new AbortController()
    controller.signal.addEventListener('abort', (event) => { event.stopImmediatePropagation() }, { once: true })
    const reason = new Error('cancel request despite propagation stop')
    const request = store.readImageRequest(ref, policy, controller.signal)
    const rejected = expect(request).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
    expect(getEventListeners(controller.signal, 'abort')).toEqual([])
    expect(existsSync(join(store.root, 'request-images'))).toBe(false)
    await expect(store.readImageRequest(ref, policy)).resolves.toMatchObject({ width: 10, height: 5 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('reports a cache filesystem failure without replacing the failed path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-request-cache-error-'))
  try {
    const store = new LocalAttachmentStore(new Context(), { dshHome: home })
    const ref = await store.saveImage({ data: await source(), mediaType: 'image/png' })
    const hash = requestImageVariantId(ref, policy).slice('sha256:'.length)
    const path = join(store.root, 'request-images', hash.slice(0, 2), hash)
    await mkdir(path, { recursive: true })
    await expect(store.readImageRequest(ref, policy)).rejects.toMatchObject({ code: 'EISDIR', syscall: 'read' })
    await rm(path, { recursive: true })
    await expect(store.readImageRequest(ref, policy)).resolves.toMatchObject({ width: 10, height: 5 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
