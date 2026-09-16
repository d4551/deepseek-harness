import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'

const roots: string[] = []
const backends: JsonStorageBackend[] = []
const inspectors: Session[] = []

afterEach(async () => {
  for (const inspector of inspectors.splice(0)) inspector.disconnect()
  for (const backend of backends.splice(0)) await backend.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Observe a failed public write without retaining its rejection or promise. */
async function failedWriteError(unit: KvUnit): Promise<WeakRef<Error>> {
  const [outcome] = await Promise.allSettled([unit.putRecord('items', 'saved', true)])
  if (outcome?.status !== 'rejected' || !(outcome.reason instanceof Error)) {
    throw new Error('The obstructed table directory must reject the write with an Error')
  }
  return new WeakRef(outcome.reason)
}

it('releases settled write failures while their storage unit remains open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-json-write-retention-'))
  roots.push(root)
  const backend = new JsonStorageBackend(root)
  backends.push(backend)
  const unit = await backend.kv.open({
    name: 'records', version: 1, tables: ['items'], hasGlobal: false, layout: 'per-record',
  })
  await mkdir(join(root, 'records'))
  const obstruction = join(root, 'records', 'items')
  await writeFile(obstruction, 'A file cannot contain record documents')

  const error = await failedWriteError(unit)
  const inspector = new Session()
  inspectors.push(inspector)
  inspector.connect()
  // WeakRef keeps its target alive until the current JavaScript job ends.
  await setImmediate()
  await inspector.post('HeapProfiler.collectGarbage')
  expect(error.deref()).toBeUndefined()

  await rm(obstruction)
  await unit.putRecord('items', 'saved', true)
  expect(await unit.loadAll()).toEqual({ tables: { items: { saved: true } }, global: null })
})
