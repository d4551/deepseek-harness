import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { boot } from '../../../../boot/app-boot/lib/index.js'

const [configPath, home] = process.argv.slice(2)
if (configPath === undefined || home === undefined) throw new Error('Expected configuration and storage paths')
const ctx = await boot('attachment-admission-test', configPath)
try {
  const data = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
    'base64',
  )
  const controller = new AbortController()
  const reason = new Error('cancel loaded image admission')
  const pending = ctx.attachments.saveImages([
    { data, mediaType: 'image/png' },
    { data, mediaType: 'image/png' },
  ], controller.signal)
  const rejected = assert.rejects(pending, error => error === reason)
  controller.abort(reason)
  await rejected
  assert.deepEqual(await readdir(home), [])
  const ref = await ctx.attachments.saveImage({ data, mediaType: 'image/png' })
  const stored = await ctx.attachments.readImage(ref)
  assert.deepEqual(Buffer.from(stored.data), data)
  const requestController = new AbortController()
  requestController.signal.addEventListener('abort', (event) => { event.stopImmediatePropagation() }, { once: true })
  const requestReason = new Error('cancel loaded image request')
  const requestPolicy = { maxPixels: 1, maxBytes: 1024 }
  const request = ctx.attachments.readImageRequest(ref, requestPolicy, requestController.signal)
  const requestRejected = assert.rejects(request, error => error === requestReason)
  requestController.abort(requestReason)
  await requestRejected
  const subsequent = await ctx.attachments.readImageRequest(ref, requestPolicy)
  assert.deepEqual(Buffer.from(subsequent.data), data)
  process.stdout.write('Cancelled admission published nothing; subsequent admission and request are readable.\n')
} finally {
  await ctx.fiber.dispose()
}
