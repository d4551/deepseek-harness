/**
 * On-disk JSON unit format: the file is always the current net state, kept
 * human-readable (pretty-printed, stable key order from insertion) — that
 * legibility is this backend's reason to exist. `single`-layout units are
 * one document with a unit header; `per-record`-layout units are a directory
 * with one version-stamped document per record (`<table>/<key>.json`) plus a
 * `global.json` for the global slot, so a write rewrites one record instead
 * of the whole unit.
 * @module @deepseek-ai/dsh-storage-json/src/format
 */

import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

/** In-memory authoritative state of one unit; the file is its projection. `global` is `null` until first written. */
export interface UnitState {
  version: number
  global: unknown
  tables: Map<string, Map<string, unknown>>
}

/**
 * Serialize a unit state to file content.
 * @param name - Unit name, stamped into the header.
 * @param state - Authoritative in-memory state.
 * @returns pretty-printed JSON document with a trailing newline.
 */
export function serialize(name: string, state: UnitState): string {
  const tables: Record<string, Record<string, unknown>> = {}
  for (const [table, records] of state.tables) {
    tables[table] = Object.fromEntries(records)
  }
  const document = {
    unit: { name, version: state.version },
    global: state.global,
    tables,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Parse file content into unit state, validating shape and version.
 * @param text - Raw file content.
 * @param descriptor - Expected identity; version mismatch rejects.
 * @returns the parsed state.
 */
export function parse(text: string, descriptor: KvUnitDescriptor): UnitState {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': file is not valid JSON`, { cause: error })
  }
  if (typeof document !== 'object' || document === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': file is not a JSON object`)
  }
  const fields = new Map<string, unknown>(Object.entries(document))
  const unit = fields.get('unit')
  if (typeof unit !== 'object' || unit === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': missing or foreign unit header`)
  }
  const header = new Map<string, unknown>(Object.entries(unit))
  const version = header.get('version')
  if (header.get('name') !== descriptor.name || typeof version !== 'number') {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': missing or foreign unit header`)
  }
  if (version !== descriptor.version) {
    throw new StorageError(
      'version-mismatch',
      `unit '${descriptor.name}': stored version ${version} != expected ${descriptor.version}`,
    )
  }
  const tables = fields.get('tables')
  if (typeof tables !== 'object' || tables === null) {
    throw new StorageError('malformed-medium', `unit '${descriptor.name}': tables is not an object`)
  }
  const declaredTables = new Map<string, unknown>(Object.entries(tables))
  const state: UnitState = { version, global: fields.get('global') ?? null, tables: new Map() }
  for (const table of descriptor.tables) {
    const records = declaredTables.get(table)
    if (records === undefined) {
      state.tables.set(table, new Map())
      continue
    }
    if (typeof records !== 'object' || records === null || Array.isArray(records)) {
      throw new StorageError('malformed-medium', `unit '${descriptor.name}': table '${table}' is not an object`)
    }
    state.tables.set(table, new Map(Object.entries(records)))
  }
  return state
}

/**
 * Serialize one per-record document: the unit's version stamp plus the
 * record value, pretty-printed like the whole-unit document.
 * @param version - Unit format version, stamped into the header.
 * @param value - The record value (or the global singleton value).
 * @returns pretty-printed JSON document with a trailing newline.
 */
export function serializeRecord(version: number, value: unknown): string {
  return `${JSON.stringify({ version, record: value }, null, 2)}\n`
}

/**
 * Serialize durable absence without retaining the deleted record's value.
 * @param version - Unit format version stamped into the deletion document.
 * @returns pretty-printed deletion document with a trailing newline.
 */
export function serializeDeletion(version: number): string {
  return `${JSON.stringify({ version, deleted: true }, null, 2)}\n`
}

/**
 * Parse one per-record document, validating its version stamp. A document
 * that is malformed or stamped with a different version is FOREIGN and reads
 * as absent — the per-record contract: one bad or stale record file must not
 * brick the whole unit, and a version bump discards stale records instead of
 * migrating them (the whole-unit format rejects instead, because there is
 * exactly one document).
 * @param text - Raw per-record document content.
 * @param version - Expected unit version; a mismatch discards the document.
 * @returns the record value, or `undefined` for a foreign document.
 */
export function parseRecord(text: string, version: number): unknown {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null) return undefined
  const fields = new Map<string, unknown>(Object.entries(document))
  if (fields.get('version') !== version) return undefined
  if (fields.get('deleted') === true) return undefined
  return fields.get('record')
}
