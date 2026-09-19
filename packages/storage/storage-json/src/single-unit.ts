/**
 * One opened JSON unit in `single` layout: the whole unit is one document at
 * `<root>/<name>.json`. Reads expose the last committed state; every write
 * publishes its candidate document durably before making it visible. Writes are
 * NOT queued here — per the backend contract, write ordering belongs to the
 * caller (the domain layer's write chain); this unit only guarantees that
 * each single call publishes a complete, durable file. The `per-record`
 * layout is a separate unit class in `per-record-unit.ts`.
 * @module @deepseek-ai/dsh-storage-json/src/single-unit
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { writeAtomic } from './atomic.ts'
import { parse, serialize } from './format.ts'
import type { UnitState } from './format.ts'
import { JsonUnitLifecycle } from './unit-lifecycle.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/** Whether a claim-boundary value reports a missing path. */
function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Open (load or lazily create) one `single`-layout unit under `root`: the
 * unit file is `<root>/<name>.json`.
 * @param descriptor - Static identity and shape of the unit.
 * @param root - Absolute backend root directory.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @returns the opened unit.
 */
export function openSingleUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  const path = join(root, `${descriptor.name}.json`)
  return readFile(path, 'utf8').then(
    text => new SingleJsonUnit(descriptor, path, parse(text, descriptor), onClose),
    (error: Thrown) => {
      if (!isENOENT(error)) throw error
      // Missing file = empty unit; materialization defers to the first write.
      return new SingleJsonUnit(descriptor, path, {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }, onClose)
    },
  )
}

class SingleJsonUnit extends JsonUnitLifecycle implements KvUnit {
  constructor(
    descriptor: KvUnitDescriptor,
    private readonly path: string,
    private state: UnitState,
    onClose: () => void,
  ) {
    super(descriptor, onClose)
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return new Promise((resolve) => {
      this.assertOpen()
      const tables: Record<string, Record<string, unknown>> = {}
      for (const [table, records] of this.state.tables) {
        tables[table] = Object.fromEntries(records)
      }
      resolve({ tables, global: this.state.global })
    })
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const records = new Map(this.records(table))
    records.set(key, value)
    const tables = new Map(this.state.tables)
    tables.set(table, records)
    await this.tracked(this.publish({ ...this.state, tables }))
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    if (!records.has(key)) return
    const nextRecords = new Map(records)
    nextRecords.delete(key)
    const tables = new Map(this.state.tables)
    tables.set(table, nextRecords)
    await this.tracked(this.publish({ ...this.state, tables }))
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    this.assertGlobalDeclared()
    await this.tracked(this.publish({ ...this.state, global: value }))
  }

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  private async publish(state: UnitState): Promise<void> {
    await writeAtomic(this.path, serialize(this.descriptor.name, state))
    this.state = state
  }
}
