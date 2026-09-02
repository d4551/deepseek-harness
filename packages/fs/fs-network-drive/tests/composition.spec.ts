/**
 * Real-composition guard: the drive provider, the drive-backed filesystem, and
 * the sandbox policy boot from a test-only cordis.yml through the actual Loader
 * and Include path. Only the WebDAV endpoint is stubbed — every plugin, config
 * schema, injection, and `!!js` expression is the shipped one.
 *
 * What it proves: the composed `ctx.fs` hydrates a drive file into the same
 * directory `sandbox-policy` fences by, hands out a process path that exists on
 * disk, and publishes a write back to the endpoint before reporting success.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import WebDavNetworkDrive from '@deepseek-ai/dsh-network-drive-webdav'
import type { FileStat, WebDAVClientOptions } from 'webdav'
import NetworkDriveFileSystem from '../src/index.ts'

interface StubNode {
  type: 'file' | 'directory'
  content: string
  etag: string
}

const server = new Map<string, StubNode>()
const puts: string[] = []

function statOf(path: string): FileStat {
  const node = server.get(path)
  if (node === undefined) throw Object.assign(new Error('Invalid response: 404'), { status: 404 })
  return {
    filename: path,
    basename: path.slice(path.lastIndexOf('/') + 1),
    lastmod: 'Tue, 03 Sep 2026 00:00:00 GMT',
    size: new TextEncoder().encode(node.content).byteLength,
    type: node.type,
    etag: node.etag,
  }
}

// `bun test` implements `vi.mock` but not `vi.importActual`, so the factory is
// fully self-contained: only the enum members the provider reads and the client
// surface it touches are stubbed, against the in-memory WebDAV server above.
// The enum lives inside the factory because `vi.mock` hoists above every
// top-level binding; the server map is safe to close over because the stubbed
// methods only dereference it once a test invokes them.
vi.mock('webdav', () => ({
  AuthType: {
    Auto: 'auto',
    Password: 'password',
    Digest: 'digest',
    None: 'none',
    Token: 'token',
  },
  createClient: (_url: string, _options: WebDAVClientOptions) => ({
    stat: async (path: string) => statOf(path),
    getDirectoryContents: async (path: string) => {
      statOf(path)
      return [...server.keys()]
        .filter(candidate => candidate !== path && candidate.slice(0, candidate.lastIndexOf('/')) === (path === '/' ? '' : path))
        .map(statOf)
    },
    getFileContents: async (path: string) => {
      const node = server.get(path)
      if (node === undefined) throw Object.assign(new Error('Invalid response: 404'), { status: 404 })
      return new TextEncoder().encode(node.content).buffer
    },
    putFileContents: async (path: string, data: ArrayBuffer) => {
      const content = new TextDecoder().decode(new Uint8Array(data))
      puts.push(`${path}:${content}`)
      server.set(path, { type: 'file', content, etag: `"rev-${puts.length}"` })
      return true
    },
    createDirectory: async (path: string) => {
      if (!server.has(path)) server.set(path, { type: 'directory', content: '', etag: '"dir"' })
    },
    deleteFile: async (path: string) => { server.delete(path) },
    moveFile: async (from: string, to: string) => {
      const node = server.get(from)
      if (node !== undefined) {
        server.delete(from)
        server.set(to, node)
      }
    },
  }),
}))

const configPath = fileURLToPath(new URL('./fixtures/composition/cordis.yml', import.meta.url))

let workspace: string | undefined
let context: Context | undefined

beforeEach(() => {
  server.clear()
  server.set('/', { type: 'directory', content: '', etag: '"root"' })
  puts.length = 0
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function boot(): Promise<Context> {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-hosted-drive-')))

  const ctx = new Context()
  context = ctx
  // `bun test` implements `vi.mock` but not `vi.stubEnv`/`vi.unstubAllEnvs`, so
  // the fixture reads its per-run inputs from a service on the context — the
  // same `!!js` evaluation path, without ambient environment writes.
  ctx.reflect.provide('driveFixture', {
    workspace,
    url: 'https://drive.example.com/dav',
  })
  ctx.baseUrl = `${pathToFileURL(workspace).href}/`
  await ctx.plugin(Loader)
  // The composition's four modules are registered as loader builtins, so the
  // fixture's `cordis:` names resolve through the loader's normal path.
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.invariants = InvariantRegistry
  ctx.loader.builtins['sandbox-policy'] = SandboxPolicyService
  ctx.loader.builtins['network-drive-webdav'] = WebDavNetworkDrive
  ctx.loader.builtins['fs-network-drive'] = NetworkDriveFileSystem
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('hosted network-drive composition', () => {
  it('boots from cordis.yml and serves the drive through ctx.fs in the fenced workspace', async () => {
    server.set('/README.md', { type: 'file', content: '# hosted\n', etag: '"rev-0"' })
    const ctx = await boot()

    // One execution world: the materialization root the filesystem provider
    // owns is the directory the sandbox policy fences by.
    const fs = ctx.fs as NetworkDriveFileSystem
    expect(fs).toBeInstanceOf(NetworkDriveFileSystem)
    expect(fs.materializationRoot).toBe(workspace)
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(workspace)

    const target = await ctx.fs.resolve('README.md')
    await expect(ctx.fs.readText(target)).resolves.toBe('# hosted\n')
    const processPath = ctx.fs.processPath(target)
    expect(processPath).toBe(join(workspace!, 'README.md'))
    expect(existsSync(processPath)).toBe(true)
    await expect(readFile(processPath, 'utf8')).resolves.toBe('# hosted\n')
  })

  it('publishes a composed write to the endpoint before it reports success', async () => {
    server.set('/README.md', { type: 'file', content: 'before\n', etag: '"rev-0"' })
    const ctx = await boot()
    const target = await ctx.fs.resolve('README.md')
    await ctx.fs.readText(target)

    const outcome = await ctx.fs.writeText(target, 'after\n')

    expect(puts).toEqual(['/README.md:after\n'])
    expect(server.get('/README.md')?.content).toBe('after\n')
    expect(outcome).toMatchObject({ operation: 'update', before: 'before\n', after: 'after\n' })
    await expect(readFile(join(workspace!, 'README.md'), 'utf8')).resolves.toBe('after\n')
  })

  it('lists the drive through the composed filesystem', async () => {
    server.set('/a.md', { type: 'file', content: 'a', etag: '"rev-a"' })
    server.set('/b.md', { type: 'file', content: 'b', etag: '"rev-b"' })
    const ctx = await boot()

    const listed = await ctx.fs.listDir(await ctx.fs.resolve('.'))
    expect(listed.map(entry => entry.name)).toEqual(['a.md', 'b.md'])
  })
})
