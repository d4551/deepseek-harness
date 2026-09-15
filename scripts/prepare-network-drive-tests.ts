import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import server from '../packages/fs/fs-network-drive/tests/fixtures/webdav/server.json' with { type: 'json' }
import { nativeRclonePath, verifyNativeRclone, nativeArtifact } from '../packages/fs/fs-network-drive/tests/native-rclone.ts'

if (process.platform === 'win32' || process.platform === 'darwin') {
  const artifact = nativeArtifact(process.platform, process.arch)
  const executable = nativeRclonePath(process.platform, process.arch)
  const directory = dirname(executable)
  await mkdir(directory, { recursive: true })
  await using staging = {
    path: await mkdtemp(join(directory, 'download-')),
    [Symbol.asyncDispose]() { return rm(this.path, { recursive: true, force: true }) },
  }
  const suppliedArchive = process.argv[2]
  const bytes = suppliedArchive === undefined
    ? await downloadArchive(`https://beta.rclone.org/${server.version}/${artifact.archive}`)
    : await readFile(suppliedArchive)
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.archiveSha256) throw new Error('rclone archive checksum does not match its pinned build')
  const archive = join(staging.path, 'rclone.zip')
  await writeFile(archive, bytes)
  const member = `${artifact.archive.slice(0, -4)}/${process.platform === 'win32' ? 'rclone.exe' : 'rclone'}`
  execFileSync('tar', ['-xf', archive, '-C', staging.path, member], { stdio: 'inherit' })
  const extracted = join(staging.path, member)
  if (createHash('sha256').update(await readFile(extracted)).digest('hex') !== artifact.executableSha256) throw new Error('rclone executable checksum does not match its pinned build')
  await rename(extracted, executable)
  execFileSync(await verifyNativeRclone(process.platform, process.arch), ['version'], { stdio: 'inherit' })
} else {
  execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'inherit' })
  execFileSync('docker', ['pull', server.image], { stdio: 'inherit' })
  execFileSync('docker', ['run', '--rm', '--pull=never', server.image, 'version'], { stdio: 'inherit' })
}

async function downloadArchive(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`rclone artifact download failed: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}
