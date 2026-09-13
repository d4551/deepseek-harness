import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

function inside(root: string, path: string): void {
  const remainder = relative(root, path)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`integration build input escapes its source: ${path}`)
  }
}

/** Bind every physical entry in the release members, including generated output. */
export function integrationBuildInputs(root: string, directories: readonly string[]): string {
  const physicalRoot = realpathSync(root)
  const digest = createHash('sha256')
  const pending = [...new Set(directories.map(directory => resolve(physicalRoot, directory)))].sort().reverse()
  const visited = new Set<string>()
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined || visited.has(path)) continue
    visited.add(path)
    inside(physicalRoot, path)
    const before = lstatSync(path, { bigint: true })
    const name = relative(physicalRoot, path).split(sep).join('/')
    digest.update(JSON.stringify([name, String(before.dev), String(before.ino), String(before.mode)]))
    if (before.isSymbolicLink()) {
      const target = realpathSync(path)
      inside(physicalRoot, target)
      digest.update(JSON.stringify(['link', readlinkSync(path)]))
      pending.push(target)
    } else if (before.isDirectory()) {
      for (const entry of readdirSync(path).sort().reverse()) pending.push(join(path, entry))
    } else if (before.isFile()) {
      digest.update(JSON.stringify(['file', String(before.size), String(before.mtimeNs), String(before.ctimeNs)]))
      digest.update(readFileSync(path))
    } else {
      throw new Error(`integration build input is not a file, directory, or link: ${name}`)
    }
    const after = lstatSync(path, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`integration build input changed while reading: ${name}`)
    }
  }
  if (visited.size === 0) throw new Error('integration build input inventory is empty')
  return digest.digest('hex')
}
