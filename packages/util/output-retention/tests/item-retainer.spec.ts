import { describe, expect, it } from 'vitest'
import { ItemRetainer, type Omitted } from '@deepseek-ai/dsh-output-retention'

describe('ItemRetainer — head retention', () => {
  it('keeps the first maxItems while callers keep draining for an exact omitted count', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 2 })
    expect(r.push('a')).toEqual({ kept: true, truncated: false })
    expect(r.push('b')).toEqual({ kept: true, truncated: false })
    expect(r.push('c')).toEqual({ kept: false, truncated: true })

    const result = r.finish()
    expect(result.items).toEqual(['a', 'b'])
    expect(result.kept).toBe(2)
    expect(result.seen).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.omitted).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })

  it('reports none when everything fits', () => {
    const r = new ItemRetainer<number>({ kind: 'head', maxItems: 3 })
    r.push(1)
    r.push(2)
    const result = r.finish()
    expect(result.items).toEqual([1, 2])
    expect(result.truncated).toBe(false)
    expect(result.omitted).toEqual<Omitted>({ kind: 'none' })
  })
  it('keeps draining past the cap and reports an exact omitted count', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 1 })
    expect(r.push('a')).toEqual({ kept: true, truncated: false })
    expect(r.push('b')).toEqual({ kept: false, truncated: true })
    expect(r.push('c')).toEqual({ kept: false, truncated: true })

    const result = r.finish()
    expect(result.items).toEqual(['a'])
    expect(result.seen).toBe(3)
    expect(result.omitted).toEqual<Omitted>({ kind: 'exact', count: 2 })
  })
})

describe('ItemRetainer — zero budget', () => {
  it('keeps nothing and counts every pushed item as omitted', () => {
    const r = new ItemRetainer<string>({ kind: 'head', maxItems: 0 })
    expect(r.push('a')).toEqual({ kept: false, truncated: true })
    const result = r.finish()
    expect(result.items).toEqual([])
    expect(result.kept).toBe(0)
    expect(result.omitted).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })

  it('rejects a non-integer / negative maxItems', () => {
    expect(() => new ItemRetainer({ kind: 'head', maxItems: -1 }))
      .toThrow(/maxItems must be a non-negative integer/)
    expect(() => new ItemRetainer({ kind: 'head', maxItems: 1.5 }))
      .toThrow(/maxItems must be a non-negative integer/)
  })
})
