/** Native Worker fixture: production globals, child-worker entry, and packed modules. */
import '../../../src/worker.ts'
import { alsCausality } from '../../../src/node/builtin_modules/implemented/async_hooks.ts'
import { createNodeBuiltins, REPLACED_PREFIXES } from '../../../src/node/builtins.ts'
import { installProcessGlobal } from '../../../src/node/globals/process.ts'
import { setActiveModuleLoader, WorkerModuleLoader } from '../../../src/module-system/module-loader.ts'
import { setActiveVfs } from '../../../src/storage/active.ts'
import { inflateImageStream } from '../../../src/storage/image-gzip.ts'
import { loadVfsImage } from '../../../src/storage/memory.ts'

async function run(image: string, scenario: string): Promise<void> {
  const process = installProcessGlobal({
    cwd: '/dsh/workspace',
    env: { DSH_HOME: '/dsh/home' },
    argv: ['node', 'sandbox-stack', scenario],
  })
  const response = await fetch(image)
  if (!response.ok || response.body === null) throw new Error(`Sandbox image fetch failed: ${response.status}`)
  const vfs = loadVfsImage(await inflateImageStream(response.body, image), '/dsh')
  setActiveVfs(vfs)
  const modules = new WorkerModuleLoader({
    vfs,
    root: '/dsh',
    staticModules: { ...createNodeBuiltins(), process: () => process, 'node:process': () => process },
    staticModulePrefixes: REPLACED_PREFIXES,
    alsCausality,
  })
  setActiveModuleLoader(modules)
  await modules.precompile()
  const commands = modules.requireFrom('/dsh')('./test/commands.mjs')
  if (typeof commands !== 'object' || commands === null || !('result' in commands)
    || !(commands.result instanceof Promise)) {
    throw new Error('Packed sandbox scenario did not export its completion promise')
  }
  const result: unknown = await commands.result
  self.postMessage({ t: 'sandbox-result', platform: process.platform, result })
}

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const error: unknown = event.reason
  self.postMessage({ t: 'sandbox-error', message: error instanceof Error ? error.stack : String(error) })
})

self.onmessage = async (event: MessageEvent<unknown>) => {
  const data = event.data
  if (typeof data !== 'object' || data === null || !('t' in data) || data.t !== 'sandbox-test') return
  if (!('image' in data) || typeof data.image !== 'string'
    || !('scenario' in data) || typeof data.scenario !== 'string') {
    throw new Error('Sandbox test frame needs image and scenario strings')
  }
  await run(data.image, data.scenario)
}
