import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { gatesForMode, runGates, type Mode } from './run-gates.ts'
import { resultFor, withBunEntrypoint } from './run-gates.spec-helpers.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

const modes: Mode[] = ['ci-primary', 'ci-linux-primary', 'check-all']

it.each(modes)('snapshots %s only after all checkout consumers settle, including failed writers', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-snapshot-'))
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const generated = join(root, 'generated')
  mkdirSync(generated)
  writeFileSync(join(generated, 'prior.md'), 'prior projection')
  const subject = withBunEntrypoint(() => gatesForMode(mode))
  const rewriting = Promise.withResolvers<undefined>()
  const finishRewrite = Promise.withResolvers<undefined>()
  const settled: string[] = []
  let copied: string[] | undefined
  let predecessors: string[] | undefined

  const execution = runGates(subject, subject.length, async (item) => {
    if (item.id === 'docs-site-build') {
      rmSync(generated, { recursive: true })
      rewriting.resolve(undefined)
      await finishRewrite.promise
      mkdirSync(generated)
      writeFileSync(join(generated, 'current.md'), 'current projection')
      settled.push(item.id)
      return resultFor(item, 'failed')
    }
    if (item.id === 'mutation') {
      copied = readdirSync(generated)
      predecessors = [...settled]
    }
    settled.push(item.id)
    return resultFor(item)
  })
  await rewriting.promise
  const duringRewrite = copied
  finishRewrite.resolve(undefined)
  const results = await execution

  expect(duringRewrite).toBeUndefined()
  expect(copied).toEqual(['current.md'])
  expect(predecessors?.toSorted()).toEqual(subject.map(item => item.id).filter(id => id !== 'mutation').toSorted())
  expect(results).toHaveLength(subject.length)
  expect(results.find(item => item.gate.id === 'docs-site-build')?.status).toBe('failed')
  expect(results.find(item => item.gate.id === 'mutation')?.status).toBe('passed')
  expect(results.filter(item => item.status === 'skipped')).toEqual([])
})
