import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconstruct } from './src/inputs.mjs'
import { run } from './src/commands.mjs'
import { packageArtifacts, verifyArtifacts } from './src/artifacts.mjs'

const owner = fileURLToPath(new URL('.', import.meta.url))
const mode = process.argv[2]
assert.ok(mode === 'check' || mode === 'rebuild', 'Usage: bun tooling/stryker/rebuild.mjs check|rebuild')
assert.equal(process.argv.length, 3, 'Unexpected rebuild arguments')
const tools = JSON.parse(await readFile(join(owner, 'provenance/toolchain.json'), 'utf8'))
assert.equal(Bun.version, tools.bun, 'Use the recorded Bun release to preserve package bytes')
const work = await mkdtemp(join(tmpdir(), 'dsh-stryker-build-'))
console.log(`Stryker reconstruction and complete logs: ${work}`)
assert.equal(run(work, 'node-version', 'node', ['--version']).trim(), tools.node)
await reconstruct(owner, work)
for (const [name, directory] of [
  ['core-source', 'packages/core'],
  ['instrumenter-source', 'packages/instrumenter'],
  ['vitest-runner-source', 'packages/vitest-runner'],
  ['upstream-build', '.'],
  ['core-regressions', 'packages/core'],
  ['vitest-runner-regressions', 'packages/vitest-runner'],
]) {
  run(work, name, 'git', ['apply', '--check', join(owner, 'patches', `${name}.patch`)], join(work, directory))
  run(work, `${name}-apply`, 'git', ['apply', join(owner, 'patches', `${name}.patch`)], join(work, directory))
}
run(work, 'install', 'bun', ['install', '--frozen-lockfile', '--linker', 'isolated', '--cache-dir', join(work, 'package-cache')])
run(work, 'compile-instrumenter', 'node', ['node_modules/typescript/bin/tsc', '-b', 'packages/instrumenter/tsconfig.standalone.json', '--force'])
run(work, 'compile', 'node', ['node_modules/typescript/bin/tsc', '-b', 'packages/core/tsconfig.standalone.json', 'packages/vitest-runner/tsconfig.standalone.json', '--force'])
run(work, 'pack-core', 'bun', ['pm', 'pack', '--filename', join(work, 'core.tgz')], join(work, 'packages/core'))
run(work, 'pack-runner', 'bun', ['pm', 'pack', '--filename', join(work, 'runner.tgz')], join(work, 'packages/vitest-runner'))
run(work, 'pack-instrumenter', 'bun', ['pm', 'pack', '--filename', join(work, 'instrumenter.tgz')], join(work, 'packages/instrumenter'))
const artifacts = await packageArtifacts(work)
const runtime = join(work, 'runtime')
await cp(join(owner, 'runtime'), runtime, { recursive: true })
await mkdir(join(runtime, 'artifacts'))
await mkdir(join(runtime, 'patches'))
await cp(join(work, 'core.tgz'), join(runtime, 'artifacts/stryker-core-10.0.0-ts7-source-repair.tgz'))
await writeFile(join(runtime, 'patches/@stryker-mutator%2Fvitest-runner@10.0.0.patch'), artifacts.get('@stryker-mutator%2Fvitest-runner@10.0.0.patch'))
await writeFile(join(runtime, 'patches/@stryker-mutator%2Finstrumenter@10.0.0.patch'), artifacts.get('@stryker-mutator%2Finstrumenter@10.0.0.patch'))
run(work, 'runtime-install', 'bun', ['install', '--frozen-lockfile', '--linker', 'isolated', '--cache-dir', join(work, 'runtime-cache')], runtime)
run(work, 'runtime-ownership', 'node', ['verify.mjs'], runtime)
run(work, 'mutation-accounting', 'node', ['--test', 'mutation-accounting.test.mjs'], runtime)
run(work, 'jsonc', 'node', ['--test', 'packages/core/test/integration/tsconfig-jsonc.test.mjs'])
run(work, 'reporter-consumer', 'node', ['verify.mjs'], join(work, 'packages/core/test/integration/reporter-registry'))
run(work, 'native-matrix', 'node', ['--test', 'packages/vitest-runner/test/integration/native-process/native-process.test.mjs'])
run(work, 'static-activation', 'node', ['../../../bin/stryker.js', 'run'], join(work, 'packages/core/test/integration/static-test-files'))
run(work, 'child-timeout', 'node', ['verify.mjs'], join(work, 'packages/core/test/integration/child-timeout'))
if (mode === 'rebuild') {
  await mkdir(join(owner, 'artifacts'), { recursive: true })
  for (const [name, bytes] of artifacts) await writeFile(join(owner, 'artifacts', name), bytes)
} else {
  await verifyArtifacts(join(owner, 'artifacts'), artifacts)
}
console.log(`Stryker ${mode} completed; complete logs and browser diagnostics remain in ${work}`)
