/** Recoverable whole-unit import and persistent authority of a per-record tree. */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { ensureDurableDirectory } from './durable-directory.ts'
import { parse, serialize, serializeRecord } from './format.ts'
import type { UnitState } from './format.ts'
import { assertSafeKey } from './record-key.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/** Whether a claim-boundary value reports a missing path. */
function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Unit-owned metadata; its presence survives deletion of every record. */
export const INITIALIZATION_FILE = '.initialization.json'

/**
 * Complete an interrupted import before exposing the tree or accepting a mutation.
 * @param descriptor - Unit identity, declared tables and current record version.
 * @param dir - Unit directory beneath an existing backend root.
 * @param materialize - Whether a mutation requires persistent authority even without import data.
 * @returns true after durable initialization; false for an unmaterialized empty read.
 * Invalid initialization metadata and filesystem failures reject without marking completion.
 */
export async function initializePerRecord(descriptor: KvUnitDescriptor, dir: string, materialize: boolean): Promise<boolean> {
  const siblings = await readdir(dirname(dir))
  const entries = siblings.includes(descriptor.name) ? await readdir(dir, { withFileTypes: true }) : []
  const metadata = join(dir, INITIALIZATION_FILE)
  if (entries.some(entry => entry.name === INITIALIZATION_FILE)) {
    const snapshot = readInitialization(await readFile(metadata, 'utf8'), descriptor.name)
    if (snapshot === 'ready') return true
    await publishSnapshot(snapshot, dir)
  } else {
    const documents = await Promise.all(entries.map(async (entry) => {
      if (entry.name === 'global.json' && descriptor.hasGlobal) return true
      if (!entry.isDirectory() || !descriptor.tables.includes(entry.name)) return false
      return (await readdir(join(dir, entry.name))).some(name => name.endsWith('.json'))
    }))
    const authoritative = documents.some(Boolean)
    const snapshot = authoritative ? undefined : await readOriginal(descriptor, dir)
    if (!authoritative && snapshot === undefined && !materialize) return false
    await ensureDurableDirectory(dir)
    if (snapshot !== undefined) {
      await writeAtomic(metadata, JSON.stringify({
        format: 1, name: descriptor.name, status: 'importing', snapshot: serialize(descriptor.name, snapshot),
      }))
      await publishSnapshot(snapshot, dir)
    }
  }
  await writeAtomic(metadata, JSON.stringify({ format: 1, name: descriptor.name, status: 'ready' }))
  return true
}

/** The captured snapshot retains its original import version across descriptor changes. */
function readInitialization(text: string, name: string): UnitState | 'ready' {
  const document: unknown = JSON.parse(text)
  if (typeof document !== 'object' || document === null
    || !('format' in document) || document.format !== 1
    || !('name' in document) || document.name !== name || !('status' in document)) {
    throw new StorageError('malformed-medium', `unit '${name}': invalid initialization record`)
  }
  if (document.status === 'ready' && Object.keys(document).length === 3) return 'ready'
  if (document.status !== 'importing' || !('snapshot' in document) || typeof document.snapshot !== 'string') {
    throw new StorageError('malformed-medium', `unit '${name}': invalid initialization state`)
  }
  if (Object.keys(document).length !== 4) {
    throw new StorageError('malformed-medium', `unit '${name}': invalid initialization fields`)
  }
  const snapshot: unknown = JSON.parse(document.snapshot)
  if (typeof snapshot !== 'object' || snapshot === null || !('unit' in snapshot)
    || typeof snapshot.unit !== 'object' || snapshot.unit === null || !('version' in snapshot.unit)
    || typeof snapshot.unit.version !== 'number' || !Number.isSafeInteger(snapshot.unit.version)
    || snapshot.unit.version < 0 || !('tables' in snapshot)
    || typeof snapshot.tables !== 'object' || snapshot.tables === null || Array.isArray(snapshot.tables)) {
    throw new StorageError('malformed-medium', `unit '${name}': invalid initialization snapshot`)
  }
  const tables = Object.keys(snapshot.tables)
  for (const table of tables) {
    if (!UNIT_NAME_RE.test(table)) throw new StorageError('malformed-medium', `unit '${name}': invalid initialization table '${table}'`)
  }
  const state = parse(document.snapshot, { name, version: snapshot.unit.version, tables, hasGlobal: false })
  for (const records of state.tables.values()) {
    for (const key of records.keys()) assertSafeKey(name, key)
  }
  return state
}

async function publishSnapshot(state: UnitState, dir: string): Promise<void> {
  for (const [table, records] of state.tables) {
    for (const [key, value] of records) {
      const path = join(dir, table, `${key}.json`)
      await ensureDurableDirectory(dirname(path))
      await writeAtomic(path, serializeRecord(state.version, value))
    }
  }
}

/** Validate the complete source before an importing record or data document is published. */
function readOriginal(descriptor: KvUnitDescriptor, dir: string): Promise<UnitState | undefined> {
  const source = join(dirname(dir), `${descriptor.name}.json`)
  return readFile(source, 'utf8').then(
    (text) => {
      let document: unknown
      try {
        document = JSON.parse(text)
      } catch {
        return undefined
      }
      if (typeof document !== 'object' || document === null || !('unit' in document) || !('tables' in document)) return undefined
      const { unit, tables } = document
      if (typeof unit !== 'object' || unit === null || !('name' in unit) || unit.name !== descriptor.name) return undefined
      if (typeof tables !== 'object' || tables === null) return undefined
      const state: UnitState = {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      for (const [table, input] of Object.entries(tables)) {
        const target = state.tables.get(table)
        if (target === undefined) continue
        const records: unknown = input
        if (typeof records !== 'object' || records === null || Array.isArray(records)) {
          throw new StorageError('malformed-medium', `unit '${descriptor.name}': table '${table}' is not an object`)
        }
        for (const [key, value] of Object.entries(records)) {
          assertSafeKey(descriptor.name, key)
          target.set(key, value)
        }
      }
      return state
    },
    (error: Thrown) => {
      if (!isENOENT(error)) throw error
      return undefined
    },
  )
}
