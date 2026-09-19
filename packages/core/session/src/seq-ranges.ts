/** Lossless range encoding for JSONL `sourceEventSeqs` arrays. */

/** A stored source sequence or inclusive consecutive range. */
export type EncodedSeq = number | [number, number]

function isStrictlyIncreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index++) {
    const previous = values.at(index - 1)
    const current = values.at(index)
    if (previous === undefined || current === undefined || !(current > previous)) return false
  }
  return true
}

/**
 * Replace profitable consecutive runs with inclusive pairs.
 * @param values - validated in-memory source sequences.
 * @returns a lossless JSON storage form.
 */
export function encodeSeqRanges(values: readonly number[]): EncodedSeq[] {
  if (!isStrictlyIncreasing(values)) return [...values]
  const encoded: EncodedSeq[] = []
  for (let start = 0; start < values.length;) {
    let end = start
    while (end + 1 < values.length) {
      const current = values.at(end)
      const next = values.at(end + 1)
      if (current === undefined || next === undefined || next !== current + 1) break
      end += 1
    }
    const startValue = values.at(start)
    const endValue = values.at(end)
    if (startValue === undefined || endValue === undefined) {
      throw new TypeError('sourceEventSeqs encode walked off the value list')
    }
    if (end - start >= 2) encoded.push([startValue, endValue])
    else {
      for (let index = start; index <= end; index += 1) {
        const value = values.at(index)
        if (value === undefined) {
          throw new TypeError('sourceEventSeqs encode walked off the value list')
        }
        encoded.push(value)
      }
    }
    start = end + 1
  }
  return encoded
}

/**
 * Expand a JSON storage-form source sequence array.
 * @param value - parsed storage value.
 * @param maxEntries - largest list permitted by the owning event.
 * @returns the in-memory source sequences.
 */
export function decodeSeqRanges(value: unknown, maxEntries = Number.MAX_SAFE_INTEGER): number[] {
  if (!Array.isArray(value)) throw new TypeError('sourceEventSeqs must be an array')
  const decoded: number[] = []
  let hasRange = false
  for (const entry of value) {
    if (typeof entry === 'number') {
      assertSeq(entry)
      if (decoded.length >= maxEntries) throw new TypeError('sourceEventSeqs exceeds its event sequence')
      decoded.push(entry)
      continue
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError('sourceEventSeqs range entries must be [start, end] pairs')
    }
    const start: unknown = entry[0]
    const end: unknown = entry[1]
    assertSeq(start)
    assertSeq(end)
    if (end < start) throw new TypeError('sourceEventSeqs ranges require start <= end')
    const length = end - start + 1
    if (length > maxEntries - decoded.length) {
      throw new TypeError('sourceEventSeqs range exceeds its event sequence')
    }
    for (let seq = start; seq <= end; seq += 1) decoded.push(seq)
    hasRange = true
  }
  if (hasRange && !isStrictlyIncreasing(decoded)) {
    throw new TypeError('sourceEventSeqs ranges must be strictly increasing')
  }
  return decoded
}

function assertSeq(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('sourceEventSeqs must contain non-negative safe integers')
  }
}
