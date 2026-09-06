import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const verifier = fileURLToPath(new URL('./verify-built-package-invariants.mjs', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: {
  invariantSource?: string
  invariantExport?: string
  runtimeChunk?: string
} = {}): { root: string; loaderUrl: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-built-package-invariants-'))
  roots.push(root)
  const packageDir = join(root, 'packages/core/probe')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-probe',
    type: 'module',
    files: ['lib/invariant.js'],
    exports: {
      './invariant': {
        default: options.invariantExport ?? './lib/invariant.js',
      },
    },
  }, null, 2)}\n`)
  writeFileSync(
    join(packageDir, 'lib/invariant.js'),
    options.invariantSource ?? "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
  )
  if (options.runtimeChunk !== undefined) {
    writeFileSync(join(packageDir, 'lib/chunk.js'), options.runtimeChunk)
  }
  const loaderPath = join(root, 'loader.mjs')
  writeFileSync(loaderPath, 'export default class Loader { unwrapExports(value) { return value } }\n')
  return { root, loaderUrl: pathToFileURL(loaderPath).href }
}

function verify(root: string, loaderUrl: string) {
  return spawnSync(process.execPath, [
    verifier,
    '--packages-root', root,
    '--loader-url', loaderUrl,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
  })
}

/** Wait for the predicate to hold, polling briefly, so a slow probe start fails the test instead of hanging it. */
async function waitFor(predicate: () => boolean, deadlineMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > deadlineMs) throw new Error('condition not reached before the deadline')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** The staged package views currently present under one fixture package. */
function stagedViews(packageDir: string): string[] {
  return readdirSync(packageDir).filter(entry => entry.startsWith('.dsh-built-invariant-'))
}

describe('built package invariant verifier', () => {
  it('loads the staged compiled self-reference through plain Node and Loader normalization', () => {
    const { root, loaderUrl } = fixture()
    const result = verify(root, loaderUrl)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('1 compiled companion(s) passed plain-Node Loader checks')
  })

  it('rejects a default export and a broken invariant export map', () => {
    const withDefault = fixture({
      invariantSource: "export default {}\nexport const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
    })
    const defaultResult = verify(withDefault.root, withDefault.loaderUrl)
    expect(defaultResult.status).toBe(1)
    expect(defaultResult.stderr).toContain('companion has a default export')

    const brokenExport = fixture({ invariantExport: './lib/missing.js' })
    const exportResult = verify(brokenExport.root, brokenExport.loaderUrl)
    expect(exportResult.status).toBe(1)
    expect(exportResult.stderr).toContain('@deepseek-ai/dsh-probe')
  })

  it('rejects an invariant bundle that needs an unstaged runtime chunk', () => {
    const { root, loaderUrl } = fixture({
      invariantSource: "export * from './chunk.js'\n",
      runtimeChunk: "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\n",
    })
    const result = verify(root, loaderUrl)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('chunk.js')
  })

  it('removes the staged package view when a companion never settles', () => {
    // Node ends the process with status 13 when the entry module's top-level
    // await cannot settle, which skips the probe's own cleanup.
    const { root, loaderUrl } = fixture({
      invariantSource: "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\nawait new Promise(() => {})\n",
    })
    const result = verify(root, loaderUrl)
    expect(result.status, result.stderr).toBe(13)
    expect(stagedViews(join(root, 'packages', 'core', 'probe'))).toEqual([])
  })
})

// POSIX delivers SIGTERM to the verifier's listener, which removes the staged
// package view before termination resumes. Windows ends the process without
// running signal listeners, so the suite declares the termination contract
// only where the platform can honor it.
if (process.platform !== 'win32') {
  describe('built package invariant verifier termination', () => {
    it('removes the staged package view when the run is terminated mid-probe', async () => {
      // The companion holds the event loop open well past the test's deadline,
      // so the verifier is still mid-probe when the signal arrives.
      const { root, loaderUrl } = fixture({
        invariantSource: "export const name = 'probe-invariant'\nexport const inject = ['invariants']\nexport const apply = () => {}\nawait new Promise(resolve => setTimeout(resolve, 60_000))\n",
      })
      const child = spawn(process.execPath, [
        verifier,
        '--packages-root', root,
        '--loader-url', loaderUrl,
      ], { stdio: 'ignore' })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => { resolve({ code, signal }) })
      })
      const packageDir = join(root, 'packages', 'core', 'probe')
      try {
        await waitFor(() => stagedViews(packageDir).length > 0)
        child.kill('SIGTERM')
        expect(await exited).toEqual({ code: null, signal: 'SIGTERM' })
        expect(stagedViews(packageDir)).toEqual([])
      } finally {
        child.kill('SIGKILL')
      }
    })
  })
}
