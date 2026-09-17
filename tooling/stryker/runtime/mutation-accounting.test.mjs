import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const coreRoot = await realpath('node_modules/@stryker-mutator/core')
const requireFromCore = createRequire(join(coreRoot, 'package.json'))
const instrumenterRoot = dirname(requireFromCore.resolve('@stryker-mutator/instrumenter/package.json'))
const { Instrumenter } = await import(pathToFileURL(join(instrumenterRoot, 'dist/src/instrumenter.js')))
const { LoggerImpl } = await import(pathToFileURL(join(coreRoot, 'dist/src/logging/logger-impl.js')))
const { LoggingBackend } = await import(pathToFileURL(join(coreRoot, 'dist/src/logging/logging-backend.js')))

for (const scenario of [
  { name: 'diagnostic string', source: "console.error('failure');", baseline: 'failure\n', changed: '\n', argument: 'StringLiteral' },
  { name: 'nested diagnostic call', source: "console.error(String('failure'));", baseline: 'failure\n', changed: '\n', argument: 'StringLiteral' },
  { name: 'arithmetic argument', source: 'console.error(2 + 3);', baseline: '5\n', changed: '-1\n', argument: 'ArithmeticOperator' },
]) {
  test(`retains and executes call and argument mutations: ${scenario.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mutant-accounting-'))
    const logging = new LoggingBackend(process.stdout)
    try {
      const name = join(directory, 'subject.mjs')
      const { files, mutants } = await new Instrumenter(new LoggerImpl('mutation-accounting', logging)).instrument(
        [{ name, content: scenario.source, mutate: true }],
        { plugins: null, excludedMutations: [], ignorers: [] },
      )
      assert.equal(files.length, 1)
      assert.equal(files[0].name, name)
      assert.deepEqual(mutants.map(mutant => mutant.mutatorName).sort(), ['CallExpression', scenario.argument].sort())
      assert.deepEqual(mutants.map(mutant => mutant.id), ['0', '1'])
      await writeFile(name, files[0].content)
      for (const mutant of [undefined, ...mutants]) {
        const env = { ...process.env }
        delete env.__STRYKER_ACTIVE_MUTANT__
        if (mutant !== undefined) {
          assert.equal(mutant.ignoreReason, undefined)
          env.__STRYKER_ACTIVE_MUTANT__ = mutant.id
        }
        const child = spawnSync(process.execPath, [name], { env, encoding: 'utf8', timeout: 5000 })
        assert.equal(child.error, undefined)
        assert.equal(child.signal, null)
        assert.equal(child.status, 0, child.stderr)
        assert.equal(child.stdout, '')
        assert.equal(child.stderr, mutant === undefined ? scenario.baseline : mutant.mutatorName === 'CallExpression' ? '' : scenario.changed)
      }
    } finally {
      await logging.dispose()
      await rm(directory, { recursive: true })
    }
  })
}

test('retains and executes throw removal alongside error text mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-throw-accounting-'))
  const logging = new LoggingBackend(process.stdout)
  try {
    const name = join(directory, 'subject.mjs')
    const { files, mutants } = await new Instrumenter(new LoggerImpl('mutation-accounting', logging)).instrument(
      [{ name, content: "throw new Error('failure');", mutate: true }],
      { plugins: null, excludedMutations: [], ignorers: [] },
    )
    assert.equal(files.length, 1)
    assert.deepEqual(mutants.map(mutant => mutant.mutatorName).sort(), ['CallExpression', 'StringLiteral'])
    assert.deepEqual(mutants.map(mutant => mutant.id), ['0', '1'])
    await writeFile(name, files[0].content)
    for (const mutant of [undefined, ...mutants]) {
      const env = { ...process.env }
      delete env.__STRYKER_ACTIVE_MUTANT__
      if (mutant !== undefined) {
        assert.equal(mutant.ignoreReason, undefined)
        env.__STRYKER_ACTIVE_MUTANT__ = mutant.id
      }
      const child = spawnSync(process.execPath, [name], { env, encoding: 'utf8', timeout: 5000 })
      assert.equal(child.error, undefined)
      assert.equal(child.signal, null)
      assert.equal(child.stdout, '')
      if (mutant?.mutatorName === 'CallExpression') {
        assert.equal(child.status, 0)
        assert.equal(child.stderr, '')
      } else {
        assert.equal(child.status, 1)
        assert.match(child.stderr, mutant === undefined ? /\nError: failure\n/ : /\nError\n/)
      }
    }
  } finally {
    await logging.dispose()
    await rm(directory, { recursive: true })
  }
})

test('parses and preserves import.meta with the default JavaScript parser', async () => {
  const logging = new LoggingBackend(process.stdout)
  try {
    const source = 'export const moduleUrl = import.meta.url;'
    const { files, mutants } = await new Instrumenter(new LoggerImpl('mutation-accounting', logging)).instrument(
      [{ name: 'module-url.mjs', content: source, mutate: true }],
      { plugins: null, excludedMutations: [], ignorers: [] },
    )
    assert.deepEqual(mutants, [])
    assert.equal(files.length, 1)
    assert.equal(files[0].content, source)
  } finally {
    await logging.dispose()
  }
})
