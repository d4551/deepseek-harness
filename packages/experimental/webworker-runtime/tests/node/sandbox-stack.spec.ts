/** Packed production sandbox providers running in native browser Workers. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import { packVfsImage } from '../../../webworker-packer/src/pack.ts'
import { indexWorkspacePackages } from '../../../webworker-packer/src/repository.ts'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url))
const resources: (() => Promise<void>)[] = []
let environment: ReturnType<typeof prepare> | undefined

async function prepare() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sandbox-worker-'))
  resources.push(async () => { await rm(directory, { recursive: true, force: true }) })
  await build({
    configFile: false,
    root: repoRoot,
    build: {
      outDir: directory,
      emptyOutDir: true,
      rolldownOptions: {
        input: join(fixtureRoot, 'sandbox-worker.ts'),
        output: { entryFileNames: 'sandbox-worker.js', format: 'es' },
      },
    },
  })
  const packed = packVfsImage({
    config: [
      '@deepseek-ai/dsh-sandbox-local',
      '@deepseek-ai/dsh-sandbox-policy',
      '@deepseek-ai/dsh-subprocess-local',
      '@deepseek-ai/dsh-bash-sandbox',
    ].map((name, index) => `- id: provider-${index}\n  name: '${name}'`).join('\n'),
    profile: 'sandbox-stack',
    workspaces: indexWorkspacePackages(repoRoot),
    resolveFrom: repoRoot,
    configTrees: [{ mount: 'test', directory: join(fixtureRoot, 'sandbox') }],
    entries: ['/dsh/test/commands.mjs'],
  })
  expect(packed.missing).toEqual([])
  const assets = new Map<string, { type: string; body: Uint8Array | string }>([
    ['/', { type: 'text/html', body: '<!doctype html><title>Sandbox Worker acceptance</title><link rel="icon" href="data:,">' }],
    ['/image.tar.gz', { type: 'application/gzip', body: packed.image }],
  ])
  for (const path of await readdir(directory, { recursive: true })) {
    if (!path.endsWith('.js')) continue
    assets.set(`/${path.replaceAll('\\', '/')}`, { type: 'text/javascript', body: await readFile(join(directory, path)) })
  }
  const server = createServer((request, response) => {
    const asset = assets.get(request.url ?? '/')
    if (asset === undefined) {
      response.writeHead(404)
      response.end(`Missing Worker test asset: ${String(request.url)}`)
      return
    }
    response.writeHead(200, { 'content-type': asset.type })
    response.end(asset.body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  resources.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Sandbox server has no TCP address')
  const origin = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({ headless: true })
  resources.push(async () => { await browser.close() })
  return { browser, origin }
}

afterAll(async () => {
  const failures: unknown[] = []
  for (const release of resources.reverse()) {
    const [result] = await Promise.allSettled([release()])
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Sandbox acceptance resource cleanup failed')
})

async function run(scenario: string): Promise<unknown> {
  const { browser, origin } = await (environment ??= prepare())
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  let workers = 0
  page.on('worker', () => { workers += 1 })
  try {
    await page.goto(origin)
    const result: unknown = await page.evaluate(async (selected) => {
      const worker = new Worker('/sandbox-worker.js', { type: 'module' })
      try {
        return await new Promise<unknown>((resolve, reject) => {
          worker.addEventListener('error', (event) => { reject(new Error(event.message)) })
          worker.addEventListener('message', (event: MessageEvent<unknown>) => {
            const data = event.data
            if (typeof data !== 'object' || data === null || !('t' in data)) {
              reject(new Error('Sandbox Worker returned an invalid frame'))
              return
            }
            if (data.t === 'sandbox-error') {
              reject(new Error('message' in data ? String(data.message) : 'Sandbox Worker failed'))
              return
            }
            resolve(data)
          })
          worker.postMessage({ t: 'sandbox-test', image: `${location.origin}/image.tar.gz`, scenario: selected })
        })
      } finally {
        worker.terminate()
      }
    }, scenario)
    expect(errors).toEqual([])
    expect(workers).toBeGreaterThanOrEqual(3)
    return result
  } finally {
    await page.close()
  }
}

describe('Worker Landlock through the production sandbox stack', () => {
  it('allows workspace and temp writes while classifying an outside write as denied', async () => {
    expect(await run('workspace')).toEqual({
      t: 'sandbox-result',
      platform: 'linux',
      result: {
        allowed: { mode: 'workspace-write', denied: false, enforcement: 'full' },
        workspace: 'workspace\n',
        temp: 'temp\n',
        denied: { mode: 'workspace-write', denied: true, enforcement: 'full' },
        deniedExitCode: 1,
        outsideExists: false,
      },
    })
  })

  it('keeps read-only confined and danger-full-access unwrapped', async () => {
    expect(await run('modes')).toEqual({
      t: 'sandbox-result',
      platform: 'linux',
      result: {
        strict: { mode: 'read-only', denied: true, enforcement: 'full' },
        strictExists: false,
        allowed: { mode: 'danger-full-access', denied: false },
        outside: 'allowed\n',
      },
    })
  })

  it('does not leak a concurrent command policy into another process', async () => {
    expect(await run('concurrent')).toEqual({
      t: 'sandbox-result',
      platform: 'linux',
      result: {
        strict: { mode: 'read-only', denied: true, enforcement: 'full' },
        writable: { mode: 'workspace-write', denied: false, enforcement: 'full' },
        strictExists: false,
        workspace: 'allowed\n',
      },
    })
  })
})
