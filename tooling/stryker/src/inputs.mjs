import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export function digest(bytes, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding)
}

export function verifyIntegrity(bytes, expected) {
  const separator = expected.indexOf('-')
  assert.ok(separator > 0, 'Integrity must contain its digest algorithm')
  assert.equal(digest(bytes, expected.slice(0, separator), 'base64'), expected.slice(separator + 1), 'Upstream archive integrity differs')
}

async function download(url, destination, integrity) {
  const response = await fetch(url)
  assert.ok(response.ok, `${url}: HTTP ${response.status}`)
  const bytes = await response.bytes()
  verifyIntegrity(bytes, integrity)
  await Bun.write(destination, bytes)
  return new Bun.Archive(bytes)
}

/** Reconstruct only from digest-verified upstream archives in a fresh owned directory. */
export async function reconstruct(owner, work) {
  const provenance = JSON.parse(await readFile(join(owner, 'provenance/upstream.json'), 'utf8'))
  await mkdir(join(work, 'upstream'))
  for (const name of ['core', 'api', 'instrumenter', 'vitest-runner']) {
    const metadata = provenance[`@stryker-mutator/${name}`]
    const archive = await download(metadata.dist.tarball, join(work, 'upstream', `${name}.tgz`), metadata.dist.integrity)
    const extraction = join(work, 'upstream', name)
    await archive.extract(extraction)
    await mkdir(join(work, 'packages'), { recursive: true })
    await rename(join(extraction, 'package'), join(work, 'packages', name))
  }
  const source = provenance.sourceArchive
  const archive = await download(source.url, join(work, 'upstream/source.tgz'), `sha256-${Buffer.from(source.sha256, 'hex').toString('base64')}`)
  const extraction = join(work, 'upstream/source')
  await archive.extract(extraction)
  const upstream = join(extraction, `stryker-js-${provenance['@stryker-mutator/core'].gitHead}`)
  for (const name of source.inputs) {
    await mkdir(join(work, name, '..'), { recursive: true })
    await cp(join(upstream, name), join(work, name), { recursive: true })
  }
  for (const name of ['core', 'instrumenter', 'vitest-runner']) {
    await cp(join(work, 'packages', name), join(work, 'original', name), { recursive: true })
    await rm(join(work, 'packages', name, 'dist'), { recursive: true })
  }
  await cp(join(owner, 'build/package.json'), join(work, 'package.json'))
  await cp(join(owner, 'build/bun.lock'), join(work, 'bun.lock'))
}

/** Hash every regular archive entry; duplicate or missing payloads change the inventory. */
export async function archiveInventory(file) {
  const entries = await new Bun.Archive(await Bun.file(file).bytes()).files()
  assert.ok(entries.size > 0, 'Package archive is empty')
  return Object.fromEntries(await Promise.all([...entries].sort(([left], [right]) => left.localeCompare(right)).map(async ([name, entry]) => [name, digest(await entry.bytes())])))
}
