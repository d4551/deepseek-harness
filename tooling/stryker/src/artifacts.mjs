import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { archiveInventory, digest } from './inputs.mjs'

async function packagePatch(work, packageName, archive) {
  const files = await new Bun.Archive(await Bun.file(archive).bytes()).files()
  const comparison = join(work, `${packageName}-package-diff`)
  for (const [name, file] of files) {
    assert.ok(name.startsWith('package/'), `Unexpected packed path: ${name}`)
    const relative = name.slice('package/'.length)
    await mkdir(join(comparison, 'current', relative, '..'), { recursive: true })
    await mkdir(join(comparison, 'original', relative, '..'), { recursive: true })
    await writeFile(join(comparison, 'current', relative), await file.bytes())
    await cp(join(work, 'original', packageName, relative), join(comparison, 'original', relative))
  }
  const diff = spawnSync('git', ['-c', 'diff.suppressBlankEmpty=true', 'diff', '--no-index', '--no-prefix', '--unified=2', '--', 'original', 'current'], { cwd: comparison, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(diff.error, undefined)
  assert.equal(diff.signal, null)
  assert.equal(diff.stderr, '')
  assert.equal(diff.status, 1, `${packageName} package must contain the maintained source changes`)
  const patch = diff.stdout.split('\n').map(line => {
    if (line.startsWith('diff --git original/')) return line.replace('diff --git original/', 'diff --git a/').replace(' current/', ' b/')
    if (line.startsWith('--- original/')) return line.replace('--- original/', '--- a/')
    if (line.startsWith('+++ current/')) return line.replace('+++ current/', '+++ b/')
    return line
  }).join('\n')
  const patchPath = join(comparison, 'package.patch')
  await writeFile(patchPath, patch)
  const whitespace = spawnSync('git', ['diff', '--no-index', '--check', '/dev/null', patchPath], { encoding: 'utf8' })
  assert.equal(whitespace.error, undefined)
  assert.equal(whitespace.signal, null)
  assert.equal(whitespace.stdout, '')
  assert.equal(whitespace.stderr, '')
  assert.equal(whitespace.status, 1)
  return patch
}

/** Compare every packed source, declaration, map and runtime file against generated output. */
export async function packageArtifacts(work) {
  const core = join(work, 'core.tgz')
  const runner = join(work, 'runner.tgz')
  const instrumenter = join(work, 'instrumenter.tgz')
  const inventory = {
    core: await archiveInventory(core),
    runner: await archiveInventory(runner),
    instrumenter: await archiveInventory(instrumenter),
  }
  const runnerPatch = await packagePatch(work, 'vitest-runner', runner)
  const instrumenterPatch = await packagePatch(work, 'instrumenter', instrumenter)
  return new Map([
    ['stryker-core-10.0.0-ts7-source-repair.tgz', await readFile(core)],
    ['@stryker-mutator%2Fvitest-runner@10.0.0.patch', Buffer.from(runnerPatch)],
    ['@stryker-mutator%2Finstrumenter@10.0.0.patch', Buffer.from(instrumenterPatch)],
    ['inventory.json', Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`)],
    ['hashes.json', Buffer.from(`${JSON.stringify({
      core: digest(await readFile(core)),
      runner: digest(await readFile(runner)),
      runnerPatch: digest(runnerPatch),
      instrumenter: digest(await readFile(instrumenter)),
      instrumenterPatch: digest(instrumenterPatch),
    }, null, 2)}\n`)],
  ])
}

export async function verifyArtifacts(directory, generated) {
  assert.deepEqual((await readdir(directory)).sort(), [...generated.keys()].sort(), 'Generated artifact set differs')
  for (const [name, bytes] of generated) {
    assert.deepEqual(await readFile(join(directory, name)), bytes, `${name} differs from its source-generated artifact`)
  }
}
