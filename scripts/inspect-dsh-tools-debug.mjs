import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

function resolveLinkTarget(linkPath, target) {
  if (isAbsolute(target)) return target
  const parent = dirname(linkPath)
  const parentReal = realpathSync(parent, { throwIfNoEntry: false })
  return join(parentReal ?? parent, target)
}

function inspectPath(path) {
  let current = path
  let hops = 0
  const hopsLog = []
  while (hops < 32) {
    const stat = lstatSync(current, { throwIfNoEntry: false })
    hopsLog.push({
      hops,
      current,
      defined: stat !== undefined,
      link: stat?.isSymbolicLink() === true,
    })
    if (stat === undefined) {
      return { kind: hops === 0 ? 'missing' : 'dangling-symlink', path, hopsLog }
    }
    if (stat.isSymbolicLink()) {
      current = resolveLinkTarget(current, readlinkSync(current))
      hops += 1
      continue
    }
    if (!stat.isDirectory()) return { kind: 'not-directory', path, hopsLog }
    return { kind: 'present', path, real: realpathSync(current), hopsLog }
  }
  return { kind: 'dangling-symlink', path, hopsLog }
}

process.stdout.write(`${JSON.stringify({
  profile: inspectPath('/Users/brandon/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tools'),
  host: inspectPath('/Users/brandon/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools'),
}, null, 2)}\n`)
