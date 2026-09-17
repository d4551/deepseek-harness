import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { archiveInventory, digest, verifyIntegrity } from './inputs.mjs'
import { packageArtifacts, verifyArtifacts } from './artifacts.mjs'

test('archive integrity accepts exact bytes and rejects altered input', () => {
  const bytes = Buffer.from('upstream source')
  const expected = `sha512-${digest(bytes, 'sha512', 'base64')}`
  verifyIntegrity(bytes, expected)
  assert.throws(() => verifyIntegrity(Buffer.from('changed source'), expected), /integrity differs/)
  assert.throws(() => verifyIntegrity(bytes, 'missing-algorithm-digest'), /Digest method not supported/)
})

test('artifact verification rejects changed and absent complete outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stryker-artifact-test-'))
  try {
    const expected = new Map([['package.tgz', Buffer.from('source output')]])
    await writeFile(join(directory, 'package.tgz'), 'source output')
    await verifyArtifacts(directory, expected)
    await writeFile(join(directory, 'package.tgz'), 'changed output')
    await assert.rejects(verifyArtifacts(directory, expected), /differs from its source-generated artifact/)
    await writeFile(join(directory, 'unexpected.tgz'), 'extra output')
    await assert.rejects(verifyArtifacts(directory, expected), /Generated artifact set differs/)
    await rm(join(directory, 'unexpected.tgz'))
    await rm(join(directory, 'package.tgz'))
    await assert.rejects(verifyArtifacts(directory, expected), /Generated artifact set differs/)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('packed inventory includes source, emitted output and license bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stryker-inventory-test-'))
  try {
    const files = { 'package/src/index.ts': 'export const result = 1', 'package/dist/index.js': 'export const result = 1;', 'package/LICENSE': 'license' }
    const archive = join(directory, 'package.tgz')
    await Bun.write(archive, new Bun.Archive(files, { compress: 'gzip' }))
    assert.deepEqual(await archiveInventory(archive), Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)])))
    await Bun.write(archive, new Bun.Archive({}))
    await assert.rejects(archiveInventory(archive), /Package archive is empty/)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('generated patches pass whitespace checks and preserve applied source bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stryker-patch-test-'))
  try {
    const original = 'export function value() {\n  const result = 1;\n\n  return result;\n}\n\n'
    const current = 'export function value() {\n  const result = 2;\n\n  return result + 1;\n}\n'
    await mkdir(join(directory, 'original/vitest-runner'), { recursive: true })
    await writeFile(join(directory, 'original/vitest-runner/subject.js'), original)
    await mkdir(join(directory, 'original/instrumenter'), { recursive: true })
    await writeFile(join(directory, 'original/instrumenter/subject.js'), original)
    await Bun.write(join(directory, 'core.tgz'), new Bun.Archive({ 'package/LICENSE': 'license' }, { compress: 'gzip' }))
    await Bun.write(join(directory, 'runner.tgz'), new Bun.Archive({ 'package/subject.js': current }, { compress: 'gzip' }))
    await Bun.write(join(directory, 'instrumenter.tgz'), new Bun.Archive({ 'package/subject.js': current }, { compress: 'gzip' }))
    const artifacts = await packageArtifacts(directory)
    for (const name of ['vitest-runner', 'instrumenter']) {
      const patchPath = join(directory, `${name}.patch`)
      const patch = artifacts.get(`@stryker-mutator%2F${name}@10.0.0.patch`)
      assert.ok(patch)
      await writeFile(patchPath, patch)
      const whitespace = spawnSync('git', ['diff', '--no-index', '--check', '/dev/null', patchPath], { encoding: 'utf8' })
      assert.equal(whitespace.stdout, '')
      assert.equal(whitespace.stderr, '')
      assert.equal(whitespace.status, 1)
      const applied = join(directory, `${name}-applied`)
      await mkdir(applied)
      await writeFile(join(applied, 'subject.js'), original)
      const result = spawnSync('git', ['apply', patchPath], { cwd: applied, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(await readFile(join(applied, 'subject.js'), 'utf8'), current)
    }
    const invalid = current.replace('  const result = 2;', '  const result = 2; ')
    await Bun.write(join(directory, 'runner.tgz'), new Bun.Archive({ 'package/subject.js': invalid }, { compress: 'gzip' }))
    await assert.rejects(packageArtifacts(directory), /trailing whitespace/)
  } finally {
    await rm(directory, { recursive: true })
  }
})
