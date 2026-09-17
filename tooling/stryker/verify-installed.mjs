import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const owner = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(owner, '../..')
const rootRequire = createRequire(join(root, 'package.json'))
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const inventory = JSON.parse(await readFile(join(owner, 'artifacts/inventory.json'), 'utf8'))
const hashes = JSON.parse(await readFile(join(owner, 'artifacts/hashes.json'), 'utf8'))
const core = dirname(rootRequire.resolve('@stryker-mutator/core/package.json'))
const coreRequire = createRequire(join(core, 'package.json'))
const runner = dirname(rootRequire.resolve('@stryker-mutator/vitest-runner/package.json'))
const runnerRequire = createRequire(join(runner, 'package.json'))
const instrumenter = dirname(coreRequire.resolve('@stryker-mutator/instrumenter/package.json'))
const api = rootRequire.resolve('@stryker-mutator/api/core')
assert.equal(coreRequire.resolve('@stryker-mutator/api/core'), api)
assert.equal(runnerRequire.resolve('@stryker-mutator/api/core'), api)
assert.equal(runnerRequire.resolve('@stryker-mutator/core/package.json'), join(core, 'package.json'))
assert.equal(await realpath(join(root, 'node_modules/.bin/stryker')), join(core, 'bin/stryker.js'))

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

let verifiedFiles = 0
for (const [name, directory] of [['core', core], ['runner', runner], ['instrumenter', instrumenter]]) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name))
  const expected = Object.entries(inventory[name])
  const expectedPaths = expected.map(([file]) => join(directory, file.slice('package/'.length)))
  if (name !== 'core') {
    const packageName = name === 'runner' ? 'vitest-runner' : name
    const patch = await readFile(join(owner, `artifacts/@stryker-mutator%2F${packageName}@10.0.0.patch`))
    const patchHash = createHash('sha1').update(patch).digest().readBigUInt64LE().toString(16)
    const marker = join(directory, `.bun-tag-${patchHash}`)
    assert.equal((await readFile(marker)).length, 0, `${name}: Bun patch marker must be empty`)
    expectedPaths.push(marker)
  }
  assert.deepEqual(files.sort(), expectedPaths.sort(), `${name}: installed file set differs`)
  for (const [file, hash] of expected) {
    assert.ok(file.startsWith('package/'))
    const installed = join(directory, file.slice('package/'.length))
    assert.equal(digest(await readFile(installed)), hash, `${name}: ${file} differs from source-generated output`)
    verifiedFiles++
  }
}

const coreArchive = 'tooling/stryker/artifacts/stryker-core-10.0.0-ts7-source-repair.tgz'
assert.equal(rootManifest.devDependencies['@stryker-mutator/core'], `file:./${coreArchive}`)
assert.equal(digest(await readFile(join(root, coreArchive))), hashes.core)
assert.equal(rootManifest.patchedDependencies['@stryker-mutator/core@10.0.0'], undefined)
for (const [name, hash] of [['instrumenter', hashes.instrumenterPatch], ['vitest-runner', hashes.runnerPatch]]) {
  const patch = `tooling/stryker/artifacts/@stryker-mutator%2F${name}@10.0.0.patch`
  assert.equal(rootManifest.patchedDependencies[`@stryker-mutator/${name}@10.0.0`], patch)
  assert.equal(digest(await readFile(join(root, patch))), hash)
}

const parser = coreRequire('jsonc-parser')
const diagnostics = []
const lock = parser.parse(await readFile(join(root, 'bun.lock'), 'utf8'), diagnostics, { allowTrailingComma: true })
assert.deepEqual(diagnostics, [])
const coreEntries = Object.entries(lock.packages).filter(([name]) => name === '@stryker-mutator/core' || name.endsWith('/@stryker-mutator/core'))
assert.equal(coreEntries.length, 1)
assert.match(coreEntries[0][1][0], /tooling\/stryker\/artifacts\/stryker-core-10\.0\.0-ts7-source-repair\.tgz$/)
assert.equal(coreEntries[0][1][1].dependencies['jsonc-parser'], '^3.3.1')
const parserManifest = coreRequire.resolve('jsonc-parser/package.json')
assert.equal(await realpath(resolve(core, '../../jsonc-parser')), dirname(parserManifest))
console.log(JSON.stringify({ core, runner, instrumenter, api, parserManifest, verifiedFiles }))
