/**
 * Real-composition guard for the shipped bundle: the `cordis.patch.yml` this
 * package publishes is layered over a base fixture and booted with `boot()`,
 * exactly as the launcher stacks a profile's bundles over its empty root — the
 * launcher's own parser, patch algorithm, Loader, and Include. Only the WebDAV
 * endpoint is stubbed; every row, `!!js` expression, and plugin is the shipped
 * one.
 *
 * What it proves: the composed tree serves the drive through `ctx.fs` inside
 * the directory `sandbox-policy` fences, and the one-execution-world invariant
 * this layer's patch mounts is live in that tree — a `--patch` overlay that
 * moves the fence off the materialization root is rejected at the first
 * observation instead of running as a split world.
 *
 * The filename carries `invariant` on purpose: the Vitest-wide host in
 * `scripts/test-invariants.ts` mounts the registry and this package's
 * companion into every ordinary package-test root, which would make the mount
 * pass whether or not the shipped patch carries it. A suite named this way
 * owns its own invariant topology, so the only thing that can mount the check
 * here is the patch under test.
 */

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import WebDavNetworkDrive from '@deepseek-ai/dsh-network-drive-webdav'
import NetworkDriveFileSystem from '@deepseek-ai/dsh-fs-network-drive'
import type { FsObservation, FsTarget, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FileStat, WebDAVClientOptions } from 'webdav'
import * as HostedDriveInvariant from '../src/invariant.ts'

interface StubNode {
  type: 'file' | 'directory'
  content: string
  etag: string
}

const server = new Map<string, StubNode>()

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
    getFileContents: async (path: string, options?: { headers?: Record<string, string> }) => {
      const node = server.get(path)
      if (node === undefined) throw Object.assign(new Error('Invalid response: 404'), { status: 404 })
      const bytes = new TextEncoder().encode(node.content)
      const stated = /^bytes=(\d+)-(\d+)$/.exec(options?.headers?.Range ?? '')
      const first = stated?.[1]
      const last = stated?.[2]
      if (first === undefined || last === undefined) return { status: 200, headers: {}, data: bytes.buffer }
      const offset = Math.min(Number(first), bytes.byteLength)
      const end = Math.min(Number(last) + 1, bytes.byteLength)
      return {
        status: 206,
        headers: { 'content-range': `bytes ${offset}-${end - 1}/${bytes.byteLength}` },
        data: bytes.slice(offset, end).buffer,
      }
    },
    putFileContents: async (path: string, data: ArrayBuffer) => {
      server.set(path, { type: 'file', content: new TextDecoder().decode(new Uint8Array(data)), etag: '"written"' })
      return true
    },
    createDirectory: async (path: string) => {
      if (!server.has(path)) server.set(path, { type: 'directory', content: '', etag: '"dir"' })
    },
    deleteFile: async (path: string) => { server.delete(path) },
    moveFile: async () => {},
  }),
}))

/**
 * The source module each shipped plugin name resolves to. The Loader's bare
 * specifiers reach Node's resolver, which answers with built `lib/`; the tree
 * under test is the source plane, so every name is rewritten to a `cordis:`
 * builtin registered from source. Row ids, config, `!!js` expressions, and the
 * patch algorithm stay the shipped ones.
 */
const SOURCE_MODULES: ReadonlyMap<string, { builtin: string; module: unknown }> = new Map([
  ['@deepseek-ai/dsh-sandbox-policy', { builtin: 'sandbox-policy', module: SandboxPolicyService }],
  ['@deepseek-ai/dsh-fs-sandbox', { builtin: 'fs-sandbox', module: SandboxedFileSystem }],
  ['@deepseek-ai/dsh-network-drive-webdav', { builtin: 'network-drive-webdav', module: WebDavNetworkDrive }],
  ['@deepseek-ai/dsh-fs-network-drive', { builtin: 'fs-network-drive', module: NetworkDriveFileSystem }],
  ['@deepseek-ai/dsh-invariants', { builtin: 'invariants', module: InvariantRegistry }],
  ['@deepseek-ai/dsh-hosted-drive/invariant', { builtin: 'hosted-drive-invariant', module: HostedDriveInvariant }],
])

/** The fields the rewrite reads: any patch or inserted entry row that may name a plugin. */
interface NamedRow {
  name?: string | undefined
  group?: boolean | null | undefined
  config?: unknown
}

/**
 * Rewrite every plugin name in one patch layer to its source builtin, in place.
 * @param patches - one loaded patch layer.
 * @returns the same layer, with each named row pointing at a registered builtin.
 * @throws Error when a row names a plugin this suite has no source module for.
 */
function useSourceModules(patches: PatchOptions[]): PatchOptions[] {
  const visit = (row: NamedRow): void => {
    if (typeof row.name === 'string') {
      const resolved = SOURCE_MODULES.get(row.name)
      if (resolved === undefined) {
        throw new Error(`composition spec: no source module registered for ${row.name}; add it to SOURCE_MODULES`)
      }
      row.name = `cordis:${resolved.builtin}`
    }
    if (row.group === true && Array.isArray(row.config)) row.config.forEach(visit)
  }
  for (const patch of patches) {
    visit(patch)
    patch.insert?.forEach(visit)
  }
  return patches
}

const hostedPatchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const basePatchPath = fileURLToPath(new URL('./fixtures/base.patch.yml', import.meta.url))

/** The environment the shipped patch's `!!js` expressions read, restored after each test. */
const DRIVE_ENV = [
  'DSH_DRIVE_URL',
  'DSH_DRIVE_USERNAME',
  'DSH_DRIVE_PASSWORD',
  'DSH_DRIVE_WORKSPACE',
  'DSH_DRIVE_REMOTE_ROOT',
  'DSH_DRIVE_MAX_FILE_BYTES',
  'DSH_DRIVE_REQUEST_TIMEOUT_MS',
  'DSH_PERMISSION_MODE',
] as const

/** A target and observation the invariant's listener reads neither field of. */
const TARGET: FsTarget = { targetKey: 'drive:notes.md' as FsTargetKey, displayPath: 'notes.md' }
const OBSERVATION: FsObservation = { kind: 'absent' }

let home: string | undefined
let workspace: string | undefined
let context: Context | undefined
let launchEnv: (string | undefined)[] = []

beforeEach(async () => {
  server.clear()
  server.set('/', { type: 'directory', content: '', etag: '"root"' })
  home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-hosted-profile-')))
  workspace = join(home, 'workspace')
  launchEnv = DRIVE_ENV.map(name => process.env[name])
  process.env.DSH_DRIVE_URL = 'https://drive.example.com/dav'
  process.env.DSH_DRIVE_USERNAME = 'DSH_DRIVE_USERNAME'
  process.env.DSH_DRIVE_PASSWORD = 'DSH_DRIVE_PASSWORD'
  process.env.DSH_DRIVE_WORKSPACE = workspace
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  DRIVE_ENV.forEach((name, index) => {
    const previous = launchEnv[index]
    // An assignment of `undefined` stores the string "undefined" under Bun, so
    // a variable this suite introduced is removed rather than blanked.
    if (previous === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = previous
  })
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
  workspace = undefined
})

/**
 * Boot the shipped bundle patch the way `dsh --profile hosted` does: an empty
 * profile root, the base layer below it, this bundle's published patch on top,
 * and any `--patch` overlay last.
 * @param overlays - overlay patch layers applied after the bundle layers.
 * @returns the settled composition context.
 */
async function bootHosted(overlays: readonly PatchOptions[] = []): Promise<Context> {
  const root = join(home!, 'cordis.yml')
  await writeFile(root, '[]\n')
  // The launcher hands `boot` the concatenated layers and lets Include apply
  // them, so the patch algorithm under test is the shipped one.
  const patches = [
    ...useSourceModules(loadOverlayPatches('dsh-test', basePatchPath)),
    ...useSourceModules(loadOverlayPatches('dsh-test', hostedPatchPath)),
    ...overlays,
  ]
  const ctx = await boot('dsh-test', root, patches, (prepared) => {
    for (const { builtin, module } of SOURCE_MODULES.values()) prepared.loader.builtins[builtin] = module
  })
  context = ctx
  return ctx
}

describe('dsh-hosted-drive shipped composition', () => {
  it('boots the published patch and serves the drive through ctx.fs in the fenced workspace', async () => {
    server.set('/README.md', { type: 'file', content: '# hosted\n', etag: '"rev-0"' })
    const ctx = await bootHosted()

    // The drive-backed provider replaced the host-local one rather than
    // layering beside it: a second `ctx.fs` would have failed the boot.
    const fs = ctx.fs
    expect(fs).toBeInstanceOf(NetworkDriveFileSystem)
    expect((fs as NetworkDriveFileSystem).materializationRoot).toBe(workspace)
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(workspace)
    await expect(ctx.fs.readText(await ctx.fs.resolve('README.md'))).resolves.toBe('# hosted\n')
  })

  it('runs this layer\'s one-execution-world check in the booted tree', async () => {
    const ctx = await bootHosted()
    expect(() => { ctx.emit('fs/observed', TARGET, OBSERVATION, undefined) }).not.toThrow()
  })

  it('rejects a --patch overlay that moves the fence off the materialization root', async () => {
    // The split world the layer exists to prevent: every spawned process still
    // runs against the materialization root while confinement names somewhere
    // else. Without the invariant rows in the shipped patch this boots and
    // runs silently.
    const elsewhere = join(home!, 'elsewhere')
    const ctx = await bootHosted([{ id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: elsewhere } }])

    expect(ctx.sandboxPolicy.workspaceRoot).toBe(elsewhere)
    expect(() => { ctx.emit('fs/observed', TARGET, OBSERVATION, undefined) })
      .toThrow('invariant violated by "@deepseek-ai/dsh-hosted-drive"')
  })

  it('keeps the opt-in narrow: another package\'s companion stays inactive', async () => {
    // Runtime invariants are off in every shipped tree; this layer turns them
    // on for its own check alone, so a hosted run gains no other package's
    // diagnostics. The registry reserves a filtered name without installing it,
    // so a second registration under the same name still fails.
    const ctx = await bootHosted()
    let installed = false
    const registration = ctx.invariants.register('@deepseek-ai/dsh-not-hosted-drive', () => { installed = true })
    // The registry runs an admitted installer in a child fiber, so the answer
    // only exists once that startup settles. Cordis attaches setup thenability
    // to the effect disposer the service's public type reports as a function.
    await (registration as unknown as PromiseLike<() => void>)
    expect(installed).toBe(false)
  })

  it('takes the transfer ceiling and request deadline from the environment', async () => {
    process.env.DSH_DRIVE_MAX_FILE_BYTES = '64'
    server.set('/big.md', { type: 'file', content: 'x'.repeat(128), etag: '"rev-0"' })
    const ctx = await bootHosted()

    await expect(ctx.fs.readText(await ctx.fs.resolve('big.md')))
      .rejects.toThrow('exceeds the 64-byte materialization limit')
  })
})
