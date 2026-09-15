import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import WebDavNetworkDrive from '@deepseek-ai/dsh-network-drive-webdav'
import { expect, onTestFinished } from 'vitest'
import NetworkDriveFileSystem from '../src/index.ts'
import server from './fixtures/webdav/server.json' with { type: 'json' }
import { startNativeWebDav, verifyNativeRclone } from './native-rclone.ts'

const execute = promisify(execFile)
const composition = fileURLToPath(new URL('./fixtures/composition/cordis.yml', import.meta.url))

export async function bootWebDav(): Promise<{ ctx: Context; workspace: string; remote: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-webdav-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const remote = join(root, 'remote')
  await mkdir(workspace)
  await mkdir(remote)
  const url = process.platform === 'win32' || process.platform === 'darwin' ? await bootNative(remote, root) : await bootContainer(remote)
  await expect.poll(async () => {
    const response = await fetch(url)
    await response.arrayBuffer()
    return response.status
  }, { timeout: 5000 }).toBe(200)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.reflect.provide('driveFixture', { workspace, url })
  ctx.baseUrl = `${pathToFileURL(workspace).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.invariants = InvariantRegistry
  ctx.loader.builtins['sandbox-policy'] = SandboxPolicyService
  ctx.loader.builtins['network-drive-webdav'] = WebDavNetworkDrive
  ctx.loader.builtins['fs-network-drive'] = NetworkDriveFileSystem
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(composition).href } })
  await ctx.loader.await()
  return { ctx, workspace, remote }
}

async function bootNative(remote: string, root: string): Promise<string> {
  const executable = await verifyNativeRclone(process.platform, process.arch)
  const config = join(root, 'rclone.conf')
  await writeFile(config, '')
  const service = await startNativeWebDav(executable, remote, config)
  onTestFinished(() => service[Symbol.asyncDispose]())
  return service.url
}

async function bootContainer(remote: string): Promise<string> {
  await execute('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 })
  await execute('docker', ['image', 'inspect', server.image], { timeout: 10_000 })
  const container = `dsh-webdav-${randomUUID()}`
  const owner = await stat(remote)
  await execute('docker', [
    'create', '--name', container, '--pull=never', '--publish', '127.0.0.1::8080',
    '--user', `${owner.uid}:${owner.gid}`,
    '--mount', `type=bind,source=${remote},target=/data`, server.image,
    'serve', 'webdav', '/data', '--config', '/dev/null', '--addr', ':8080', '--etag-hash', 'SHA-256', '--dir-cache-time', '0s',
  ], { timeout: 10_000 })
  onTestFinished(async () => { await execute('docker', ['rm', '--force', container], { timeout: 10_000 }) })
  await execute('docker', ['start', container], { timeout: 10_000 })
  const { stdout } = await execute('docker', ['port', container, '8080/tcp'], { timeout: 10_000 })
  const address = stdout.trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error(`unexpected WebDAV listener: ${address}`)
  return `http://${address}`
}
