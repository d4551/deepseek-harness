import { throws } from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { parse, parseRecord, serialize, serializeDeletion, serializeRecord } from '../src/format.ts'

const descriptor: KvUnitDescriptor = {
  name: 'records', version: 2, tables: ['items', 'constructor', 'prototype'], hasGlobal: true,
}

describe('JSON medium format', () => {
  it('represents deletion explicitly without confusing stored values with absence', () => {
    expect(JSON.parse(serializeDeletion(2))).toEqual({ version: 2, deleted: true })
    expect(parseRecord(serializeDeletion(2), 2)).toBeUndefined()
    expect(parseRecord('{"version":2,"deleted":true,"record":"uncommitted"}', 2)).toBeUndefined()
    const value = { deleted: true, record: null }
    expect(parseRecord(serializeRecord(2, value), 2)).toEqual(value)
    expect(parseRecord('{"version":2,"deleted":false,"record":false}', 2)).toBe(false)
  })
  it('preserves special record keys and native object properties across serialization', () => {
    const text = '{"unit":{"name":"records","version":2},"global":{"__proto__":false},"tables":{"items":{"__proto__":{"__proto__":0,"constructor":false,"prototype":""},"constructor":null,"prototype":0}}}'
    const state = parse(text, descriptor)
    const records = state.tables.get('items')
    expect(records?.has('__proto__')).toBe(true)
    expect(records?.get('__proto__')).toStrictEqual(JSON.parse('{"__proto__":0,"constructor":false,"prototype":""}'))
    expect(records?.has('constructor')).toBe(true)
    expect(records?.get('constructor')).toBeNull()
    expect(records?.get('prototype')).toBe(0)
    expect(state.tables.get('constructor')).toStrictEqual(new Map())
    expect(state.tables.get('prototype')).toStrictEqual(new Map())
    expect(state.global).toStrictEqual(JSON.parse('{"__proto__":false}'))
    expect(parse(serialize(descriptor.name, state), descriptor)).toStrictEqual(state)
  })

  it('reads declared special-name tables from their own persisted entries', () => {
    const state = parse('{"unit":{"name":"records","version":2},"tables":{"constructor":{"saved":false},"prototype":{"saved":0}}}', descriptor)
    expect(state.tables.get('items')).toStrictEqual(new Map())
    expect(state.tables.get('constructor')).toStrictEqual(new Map([['saved', false]]))
    expect(state.tables.get('prototype')).toStrictEqual(new Map([['saved', 0]]))
  })

  it.each([null, false, 0, '', [], {}])('preserves global and record value %j', (value) => {
    const state = parse(JSON.stringify({ unit: { name: 'records', version: 2 }, global: value, tables: {} }), descriptor)
    expect(state.global).toStrictEqual(value)
    expect(parseRecord(serializeRecord(2, value), 2)).toStrictEqual(value)
  })

  it('keeps absent global and record slots distinct from present falsey values', () => {
    expect(parse('{"unit":{"name":"records","version":2},"tables":{}}', descriptor).global).toBeNull()
    expect(parseRecord('{"version":2}', 2)).toBeUndefined()
    expect(parseRecord('{"version":2,"record":null}', 2)).toBeNull()
  })

  it('keeps native duplicate-key, number, Unicode, and prototype semantics', () => {
    const text = '{"version":1,"version":2,"record":{"__proto__":1,"__proto__":2,"zero":-0,"huge":1e400,"small":1e-400,"unicode":"\\ud800"}}'
    const expected: unknown = JSON.parse('{"__proto__":2,"zero":-0,"huge":1e400,"small":1e-400,"unicode":"\\ud800"}')
    const value = parseRecord(text, 2)
    expect(value).toStrictEqual(expected)
    if (typeof value !== 'object' || value === null) throw new Error('persisted record must remain an object')
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.hasOwn(value, '__proto__')).toBe(true)
  })

  it('accepts deeply nested valid record data with native parsing', () => {
    const depth = 10_000
    const text = '['.repeat(depth) + '0' + ']'.repeat(depth)
    let value = parseRecord(`{"version":2,"record":${text}}`, 2)
    for (let index = 0; index < depth; index += 1) {
      expect(Array.isArray(value)).toBe(true)
      if (!Array.isArray(value)) throw new Error('record nesting ended before its persisted depth')
      expect(value).toHaveLength(1)
      value = value[0]
    }
    expect(value).toBe(0)
  })

  it.each(['{', '', '{/*comment*/}', '{"version":2,}', '{}{}'])
  ('retains syntax failure identity for %j', (text) => {
    throws(() => parse(text, descriptor), error => error instanceof StorageError
      && error.code === 'malformed-medium'
      && error.message === "unit 'records': file is not valid JSON"
      && error.cause instanceof SyntaxError)
    expect(parseRecord(text, 2)).toBeUndefined()
  })

  it.each([null, false, 0, 'value'])('rejects non-object document %j', (document) => {
    expect(() => parse(JSON.stringify(document), descriptor)).toThrow(expect.objectContaining({
      code: 'malformed-medium', message: "unit 'records': file is not a JSON object",
    }))
    expect(parseRecord(JSON.stringify(document), 2)).toBeUndefined()
  })

  it.each([{}, { unit: null }, { unit: 0 }, { unit: {} }, { unit: { name: 'foreign', version: 2 } },
    { unit: { name: 'records' } }, { unit: { name: 'records', version: '2' } }])
  ('rejects missing or foreign header %j', (document) => {
    expect(() => parse(JSON.stringify(document), descriptor)).toThrow(expect.objectContaining({
      code: 'malformed-medium', message: "unit 'records': missing or foreign unit header",
    }))
  })

  it('distinguishes foreign versions from malformed tables', () => {
    expect(() => parse('{"unit":{"name":"records","version":3}}', descriptor)).toThrow(expect.objectContaining({
      code: 'version-mismatch', message: "unit 'records': stored version 3 != expected 2",
    }))
    expect(parseRecord('{"version":3,"record":true}', 2)).toBeUndefined()
    expect(parseRecord('{"record":true}', 2)).toBeUndefined()
  })

  it.each([undefined, null, false, 0, 'value'])('rejects invalid tables container %j', (tables) => {
    expect(() => parse(JSON.stringify({ unit: { name: 'records', version: 2 }, tables }), descriptor))
      .toThrow(expect.objectContaining({ code: 'malformed-medium', message: "unit 'records': tables is not an object" }))
  })

  it.each([null, false, 0, 'value', []])('rejects invalid declared table %j', (items) => {
    expect(() => parse(JSON.stringify({ unit: { name: 'records', version: 2 }, tables: { items } }), descriptor))
      .toThrow(expect.objectContaining({ code: 'malformed-medium', message: "unit 'records': table 'items' is not an object" }))
  })
})
