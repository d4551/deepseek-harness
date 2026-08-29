import { describe, expect, it } from 'vitest'
import { TextRetainer, type Omitted } from '@deepseek-ai/dsh-output-retention'

/** Decode a string to UTF-8 bytes for byte-exact pushes. */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('TextRetainer — the suffix window across pushes', () => {
  it('retains exactly the readable window across pushes, trimming an oversize chunk in place', () => {
    const retainer = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 3 })
    expect(retainer.push(utf8('ab'))).toEqual({ kept: true, truncated: false })
    // One 8-byte chunk against a 3-byte window: the suffix keeps only its last
    // 3 bytes, so this push alone drops 5 bytes.
    expect(retainer.push(utf8('XXXXXXXX'))).toEqual({ kept: false, truncated: true })
    expect(retainer.push(utf8('cdef'))).toEqual({ kept: false, truncated: true })
    const result = retainer.finish()
    expect(result.text).toBe('abdef')
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 9 })
  })

  it('retains no suffix bytes while the prefix still covers the whole stream', () => {
    const retainer = new TextRetainer({ kind: 'headTail', headBytes: 10, tailBytes: 3 })
    retainer.push(utf8('abc'))
    retainer.push(utf8('de'))
    const result = retainer.finish()
    expect(result.text).toBe('abcde')
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'none' })
  })
})
