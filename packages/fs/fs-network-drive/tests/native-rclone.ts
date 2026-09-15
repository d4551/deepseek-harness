import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import server from './fixtures/webdav/server.json' with { type: 'json' }

export function nativeArtifact(platform: string, architecture: string) {
  if ((platform === 'win32' || platform === 'darwin') && (architecture === 'x64' || architecture === 'arm64')) {
    return (platform === 'win32' ? server.windows : server.darwin)[architecture]
  }
  throw new Error(`No pinned native rclone artifact for ${platform}/${architecture}`)
}

export function nativeRclonePath(platform: string, architecture: string): string {
  const artifact = nativeArtifact(platform, architecture)
  const cache = fileURLToPath(new URL('../../../../node_modules/.cache/network-drive-tests/', import.meta.url))
  return join(cache, artifact.archive.slice(0, -4), platform === 'win32' ? 'rclone.exe' : 'rclone')
}

export async function verifyNativeRclone(platform: string, architecture: string): Promise<string> {
  const executable = nativeRclonePath(platform, architecture)
  const bytes = await readFile(executable)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== nativeArtifact(platform, architecture).executableSha256) throw new Error('Native rclone executable differs from its pinned build; run test:prepare:network-drive')
  return executable
}

export interface NativeWebDavServer extends AsyncDisposable {
  readonly url: string
}

export async function startNativeWebDav(executable: string, remote: string, config: string): Promise<NativeWebDavServer> {
  const child = spawn(executable, [
    'serve', 'webdav', remote, '--config', config, '--addr', '127.0.0.1:0',
    '--etag-hash', 'SHA-256', '--dir-cache-time', '0s', '--use-json-log',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  const ready = Promise.withResolvers<string>()
  let output = ''
  const record = (chunk: Buffer): void => {
    output += chunk.toString()
    const address = /WebDav Server started on \[(http:\/\/127\.0\.0\.1:\d+\/)\]/.exec(output)?.[1]
    if (address !== undefined) ready.resolve(address)
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  child.once('error', (error) => { ready.reject(error) })
  child.once('close', (code) => { ready.reject(new Error(`rclone exited before readiness (${code}): ${output}`)) })
  const timeout = setTimeout(() => { ready.reject(new Error(`rclone did not become ready: ${output}`)) }, 5000)
  const dispose = async (): Promise<void> => {
    child.kill()
    await closed
  }
  const [result] = await Promise.allSettled([ready.promise])
  clearTimeout(timeout)
  if (result.status === 'rejected') {
    await dispose()
    throw result.reason
  }
  return { url: result.value, [Symbol.asyncDispose]: dispose }
}
