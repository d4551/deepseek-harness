import { describe, expect, it } from 'vitest'
import { TextRetainer, type Omitted, type RetainedText } from '@deepseek-ai/dsh-output-retention'

/** Decode a string to UTF-8 bytes for byte-exact pushes. */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Assert a cut introduced no replacement char of its own making. */
const noReplacement = (result: RetainedText): void => {
  expect(result.text).not.toContain('�')
}

describe('TextRetainer — UTF-8 boundary handling', () => {
  it('trims a partial codepoint at the head cut instead of emitting U+FFFD', () => {
    // '€' is 3 bytes (E2 82 AC). A 2-byte head cap keeps 'a' (61) + the first
    // byte of '€' (E2); that partial lead byte must be trimmed, not decoded to
    // a replacement char.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push('a€b') // bytes: 61 E2 82 AC 62
    const result = r.finish()
    expect(result.text).toBe('a') // partial '€' dropped, no U+FFFD
    noReplacement(result)
    // Omission counts bytes ACTUALLY absent from the returned text, including
    // the partial 'E2' the boundary trim dropped: 5 total − 1 retained = 4
    // (not the pre-trim budget of 3, which would overstate what was kept).
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 4 })
  })

  it('trims a leading partial codepoint at the tail cut', () => {
    // Tail cap 2 over 'a€b' (5 bytes) keeps AC 62 — AC is a continuation byte
    // (the middle of '€'); the leading continuation byte is dropped so the tail
    // begins on a boundary.
    const r = new TextRetainer({ kind: 'tail', maxBytes: 2 })
    r.push('a€b')
    const result = r.finish()
    expect(result.text).toBe('b') // partial '€' at the front dropped
    noReplacement(result)
    // Honest count: 5 total − 1 retained ('b') = 4, including the trimmed AC.
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 4 })
  })

  it('omitted count matches the bytes actually absent, across a headTail boundary trim', () => {
    // Regression: the exact count must equal total − retained (post-trim), never
    // the pre-trim budget. 'a€€b' is 8 bytes (61 E2 82 AC
    // E2 82 AC 62). headBytes 2 keeps 'a'+partial-E2 → trims to 'a' (1 byte);
    // tailBytes 2 keeps partial-AC+'b' → trims to 'b' (1 byte). Retained text is
    // 2 bytes, so omitted must be 8 − 2 = 6 — not the budget's 8 − 2 − 2 = 4.
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('a€€b')
    const result = r.finish()
    const retainedBytes = new TextEncoder().encode(result.text).length
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 8 - retainedBytes })
  })

  it('preserves a whole multibyte codepoint that fits exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 3 })
    r.push('€x') // '€' is exactly 3 bytes
    expect(r.finish().text).toBe('€')
  })

  it('does not reconstruct a codepoint across the omitted middle', () => {
    // headBytes ends mid-'€' and tailBytes starts mid-another '€'; neither cut
    // may glue a valid codepoint across the gap.
    const r = new TextRetainer({ kind: 'headTail', headBytes: 2, tailBytes: 2 })
    r.push('€€€') // 9 bytes
    const result = r.finish()
    noReplacement(result)
    expect(result.truncated).toBe(true)
  })

  it('accepts a raw Uint8Array chunk', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push(utf8('xy'))
    r.push(utf8('z'))
    expect(r.finish().text).toBe('xy')
  })

  it('trims a partial 2-byte codepoint at the head cut', () => {
    // 'é' is 2 bytes (C3 A9). A 2-byte head cap over 'aé' keeps 'a' (61) + the
    // lead byte of 'é' (C3) — an incomplete 2-byte sequence to trim.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    r.push('aé') // bytes: 61 C3 A9
    const result = r.finish()
    expect(result.text).toBe('a')
    noReplacement(result)
  })

  it('trims a partial 4-byte codepoint (emoji) at the head cut', () => {
    // '😀' is 4 bytes (F0 9F 98 80). A 3-byte head cap keeps 'a' + the first two
    // bytes of the emoji — an incomplete 4-byte sequence that must be trimmed.
    const r = new TextRetainer({ kind: 'head', maxBytes: 3 })
    r.push('a😀') // bytes: 61 F0 9F 98 80
    const result = r.finish()
    expect(result.text).toBe('a')
    noReplacement(result)
  })

  it('keeps a whole 4-byte codepoint that fits exactly', () => {
    const r = new TextRetainer({ kind: 'head', maxBytes: 4 })
    r.push('😀x')
    expect(r.finish().text).toBe('😀')
  })

  it('leaves a head cut ending on a stray continuation run untouched', () => {
    // A cut whose trailing bytes are ALL continuation bytes with no lead in
    // reach is not a trimmable incomplete sequence — the trimmer bails (no lead
    // byte found) and leaves them for the non-fatal decoder to replace.
    const r = new TextRetainer({ kind: 'head', maxBytes: 2 })
    // 0x80 0x80 are bare continuation bytes; 'z' follows so the head keeps just
    // the two continuation bytes and the cut lands right after them.
    r.push(new Uint8Array([0x80, 0x80, 0x7a]))
    const result = r.finish()
    // The trimmer did not throw and did not eat the bytes as a partial sequence;
    // only the trailing 'z' is omitted by the 2-byte cap.
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })

  it('leaves a head cut ending on an invalid lead byte untouched', () => {
    // 0xF8 is not a valid UTF-8 lead byte (only 0x00–0xF7 lead). The trimmer
    // recognizes it as "not a lead" (expected length 0) and leaves the byte in
    // place rather than trimming a phantom partial sequence.
    const r = new TextRetainer({ kind: 'head', maxBytes: 1 })
    r.push(new Uint8Array([0xf8, 0x61])) // 0xF8 kept, 'a' dropped by the 1-byte cap
    const result = r.finish()
    expect(result.omittedBytes).toEqual<Omitted>({ kind: 'exact', count: 1 })
  })
})

/** Retain exactly `maxBytes` leading bytes of one pushed buffer. */
const headOf = (bytes: Uint8Array, maxBytes: number): string => {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(bytes)
  return retainer.finish().text
}

describe('TextRetainer - UTF-8 cut boundaries', () => {
  /** Retain exactly `maxBytes` trailing bytes of one pushed buffer. */
  const tailOf = (bytes: Uint8Array, maxBytes: number): string => {
    const retainer = new TextRetainer({ kind: 'tail', maxBytes })
    retainer.push(bytes)
    return retainer.finish().text
  }

  /** U+FFFD, what a non-fatal decoder emits for each malformed byte. */
  const REPLACEMENT = '�'
  /** Four UTF-8 bytes. */
  const GRINNING = '\u{1F600}'
  /** Two UTF-8 bytes. */
  const E_ACUTE = 'é'
  /** Three UTF-8 bytes. */
  const SNOWMAN = '☃'

  it('drops a trailing sequence cut after one, two, or three of its four bytes', () => {
    const emoji = utf8(`a${GRINNING}`)
    expect(emoji).toHaveLength(5)
    expect(headOf(emoji, 2)).toBe('a')
    expect(headOf(emoji, 3)).toBe('a')
    expect(headOf(emoji, 4)).toBe('a')
    expect(headOf(emoji, 5)).toBe(`a${GRINNING}`)
  })

  it('keeps a complete two- and three-byte sequence and drops each incomplete one', () => {
    const two = utf8(`a${E_ACUTE}`)
    expect(headOf(two, 2)).toBe('a')
    expect(headOf(two, 3)).toBe(`a${E_ACUTE}`)
    const three = utf8(`a${SNOWMAN}`)
    expect(headOf(three, 2)).toBe('a')
    expect(headOf(three, 3)).toBe('a')
    expect(headOf(three, 4)).toBe(`a${SNOWMAN}`)
  })

  it('leaves a continuation run longer than any sequence untouched', () => {
    // Five continuation bytes cannot belong to one sequence, so the scan stops
    // and the buffer is returned for the decoder to replace.
    const run = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80])
    expect(headOf(run, 5)).toBe(REPLACEMENT.repeat(5))
  })

  it('leaves a buffer that is only continuation bytes untouched', () => {
    expect(headOf(Uint8Array.from([0x80]), 1)).toBe(REPLACEMENT)
    expect(headOf(Uint8Array.from([0x80, 0x80]), 2)).toBe(REPLACEMENT.repeat(2))
  })

  it('leaves a byte that is not a valid lead untouched', () => {
    // 0xf8 starts no sequence, so the trailing continuation stays put.
    expect(headOf(Uint8Array.from([0xf8, 0x80]), 2)).toBe(REPLACEMENT.repeat(2))
  })

  it('classifies the lead byte at each sequence-length boundary', () => {
    // Each cap sits one byte below the input, so the cut is real and the trim runs.
    // 0x7f is a complete one-byte sequence; a lone 0xdf, 0xe0, or 0xf0 is not.
    expect(headOf(Uint8Array.from([0x41, 0x7f, 0x41]), 2)).toBe('A\u007f')
    expect(headOf(Uint8Array.from([0x41, 0xdf, 0xbf]), 2)).toBe('A')
    expect(headOf(Uint8Array.from([0xe0, 0xa0, 0x80]), 2)).toBe('')
    expect(headOf(Uint8Array.from([0xe0, 0xa0, 0x80, 0x41]), 3)).toBe('\u0800')
    expect(headOf(Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]), 3)).toBe('')
    expect(headOf(Uint8Array.from([0xf0, 0x9f, 0x98, 0x80, 0x41]), 4)).toBe(GRINNING)
  })

  it('drops leading continuation bytes at a suffix cut', () => {
    const emoji = utf8(`${GRINNING}b`)
    expect(emoji).toHaveLength(5)
    expect(tailOf(emoji, 2)).toBe('b')
    expect(tailOf(emoji, 3)).toBe('b')
    expect(tailOf(emoji, 4)).toBe('b')
    expect(tailOf(emoji, 5)).toBe(`${GRINNING}b`)
  })

  it('keeps a suffix that already starts on a lead byte', () => {
    expect(tailOf(utf8('ab'), 2)).toBe('ab')
    expect(tailOf(Uint8Array.from([0x41, 0xdf, 0xbf]), 2)).toBe('\u07ff')
  })
})

describe('TextRetainer - sequence length decides what a cut keeps', () => {
  it('keeps a complete two-byte sequence that a longer length would have trimmed', () => {
    // The cut leaves exactly two bytes after the lead. Reading 0xdf as a
    // two-byte lead keeps the sequence; reading it as three would drop it.
    expect(headOf(Uint8Array.from([0x41, 0xdf, 0xbf, 0x41]), 3)).toBe('A߿')
  })

  it('keeps a complete three-byte sequence that a longer length would have trimmed', () => {
    expect(headOf(Uint8Array.from([0x41, 0xe0, 0xa0, 0x80, 0x41]), 4)).toBe('Aࠀ')
  })
})
