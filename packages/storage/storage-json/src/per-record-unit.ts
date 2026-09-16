/**
 * Per-record JSON units: recoverable initialization, durable record replacement,
 * and explicit deletion documents. The directory owns state; callers order writes.
 * @module @deepseek-ai/dsh-storage-json/src/per-record-unit
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { ensureDurableDirectory } from './durable-directory.ts'
import { parseRecord, serializeDeletion, serializeRecord } from './format.ts'
import type { UnitState } from './format.ts'
import { initializePerRecord } from './initialization.ts'
import { assertSafeKey, SAFE_KEY_RE } from './record-key.ts'
import { JsonUnitLifecycle } from './unit-lifecycle.ts'

/**
 * Open a lazily initialized unit whose operations own import and durable publication.
 * @param descriptor - Validated unit identity and declared record layout.
 * @param root - Existing backend directory containing the unit tree and import source.
 * @param onClose - Release the backend's open slot after owned writes and initialization settle.
 * @returns the unit handle; its first read or mutation performs initialization.
 */
export function openPerRecordUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  return Promise.resolve(new PerRecordJsonUnit(descriptor, join(root, descriptor.name), onClose))
}

/** Read the initialized tree; unreadable, malformed, stale and deleted records remain absent. */
async function loadPerRecordState(descriptor: KvUnitDescriptor, dir: string): Promise<UnitState> {
  const state: UnitState = {
    version: descriptor.version,
    global: null,
    tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
  }
  if (!(await readdir(dirname(dir))).includes(descriptor.name)) return state
  const entries = await readdir(dir, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      const records = state.tables.get(entry.name)
      if (records !== undefined) await loadTableRecords(records, descriptor.version, join(dir, entry.name))
    }
    if (entry.name === 'global.json' && descriptor.hasGlobal) {
      const global = await readRecord(join(dir, entry.name), descriptor.version)
      if (global !== undefined) state.global = global
    }
  }))
  return state
}

async function loadTableRecords(records: Map<string, unknown>, version: number, dir: string): Promise<void> {
  const files = await readdir(dir, { withFileTypes: true })
  const loaded = await Promise.all(files.map(async (file) => {
    if (!file.name.endsWith('.json')) return
    const key = file.name.slice(0, -'.json'.length)
    if (!SAFE_KEY_RE.test(key)) return
    const record = await readRecord(join(dir, file.name), version)
    if (record !== undefined) return { key, record }
  }))
  for (const entry of loaded) {
    if (entry !== undefined) records.set(entry.key, entry.record)
  }
}

/** Read one record document; an unreadable or stale document reads as absent. */
async function readRecord(path: string, version: number): Promise<unknown> {
  try {
    return parseRecord(await readFile(path, 'utf8'), version)
  } catch {
    return undefined
  }
}

class PerRecordJsonUnit extends JsonUnitLifecycle implements KvUnit {
  private initialization: Promise<boolean> | undefined

  constructor(
    descriptor: KvUnitDescriptor,
    private readonly dir: string,
    onClose: () => void,
  ) {
    super(descriptor, onClose)
  }

  /** Initialize completely, then re-read the authoritative record tree. */
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    await this.initialize(false)
    const state = await loadPerRecordState(this.descriptor, this.dir)
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of state.tables) tables[table] = Object.fromEntries(records)
    return { tables, global: state.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(this.writeDocument(join(this.tableDir(table), `${key}.json`), serializeRecord(this.descriptor.version, value)))
  }

  /** Publish durable absence without leaving the prior value available to import. */
  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    const dir = this.tableDir(table)
    await this.tracked(this.deleteDocument(dir, key))
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    this.assertGlobalDeclared()
    await this.tracked(this.writeDocument(join(this.dir, 'global.json'), serializeRecord(this.descriptor.version, value)))
  }

  private tableDir(table: string): string {
    if (!this.descriptor.tables.includes(table)) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return join(this.dir, table)
  }

  private async initialize(materialize: boolean): Promise<boolean> {
    const completed = await (this.initialization ??= this.tracked(this.initializeTree(materialize)))
    return !completed && materialize ? this.initialize(true) : completed
  }

  private async initializeTree(materialize: boolean): Promise<boolean> {
    let completed = false
    try {
      completed = await initializePerRecord(this.descriptor, this.dir, materialize)
      return completed
    } finally {
      if (!completed) this.initialization = undefined
    }
  }

  private async writeDocument(path: string, data: string): Promise<void> {
    await this.initialize(true)
    await ensureDurableDirectory(dirname(path))
    await writeAtomic(path, data)
  }

  private async deleteDocument(dir: string, key: string): Promise<void> {
    await this.initialize(true)
    const directories = await readdir(this.dir)
    if (!directories.includes(basename(dir))) return
    const file = `${key}.json`
    if (!(await readdir(dir)).includes(file)) return
    await writeAtomic(join(dir, file), serializeDeletion(this.descriptor.version))
  }
}
