import { describe, expect, it } from 'vitest'
import { TextRetainer, type Omitted } from '@deepseek-ai/dsh-output-retention'

describe('TextRetainer — suffix window is the finish() output', () => {
  it('a single chunk larger than the tail window keeps only the last maxBytes', () => {
    // finish() reads the suffix accumulator as-is. Skipping the in-push trim
    // would return the whole chunk; there is no second slice to hide that.
    const r = new TextRetainer({ kind: 'tail', maxBytes: 4 })
    expect(r.push('abcdefghij')).toEqual({ kept: false, truncated: true })
    const result = r.finish()
    expect(result.text).toBe('ghij')
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 6 })
  })

  it('a single chunk larger than the headTail window does not leak the omitted middle', () => {
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 3 })
    r.push('abcdefghij')
    const result = r.finish()
    expect(result.text).toBe('abhij')
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 5 })
  })

  it('a later small chunk still slides a previously oversized tail window', () => {
    const r = new TextRetainer({ kind: 'tail', maxBytes: 4 })
    r.push('abcdefghij')
    r.push('xyz')
    expect(r.finish().text).toBe('jxyz')
  })
})
