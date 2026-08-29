/**
 * Byte-oriented bounded text retention with UTF-8-safe cuts.
 * @module @deepseek-ai/dsh-output-retention/text-retainer
 */
import { assertBudget } from './budget.ts'
import type { PushDecision, RetainedText, TextRetentionStrategy } from './index.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder() // utf-8, non-fatal: internal malformed bytes → U+FFFD

/**
 * Drop a trailing incomplete UTF-8 sequence so a prefix cut never emits a
 * replacement char at the boundary. Walks back over continuation bytes to the
 * lead; if fewer bytes follow than the lead declares, the sequence is trimmed.
 * A complete tail, or a run that is not a lead, is returned untouched.
 */
function trimTrailingPartialUtf8(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) return bytes
  let start = bytes.length - 1
  while (start >= 0 && ((bytes[start] as number) & 0xc0) === 0x80) start -= 1
  if (start < 0) return bytes
  const lead = bytes[start] as number
  const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0
  if (need === 0) return bytes
  return bytes.length - start < need ? bytes.subarray(0, start) : bytes
}

/**
 * Drop leading continuation bytes so a suffix cut starts on a lead/ASCII byte
 * instead of mid-codepoint.
 */
function trimLeadingContinuationUtf8(bytes: Uint8Array): Uint8Array {
  let i = 0
  for (const b of bytes) {
    if ((b & 0xc0) !== 0x80) return bytes.subarray(i)
    i += 1
  }
  return bytes.subarray(bytes.length)
}

/** Concatenate chunks into one contiguous buffer (their exact total length). */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Bounds a byte-oriented text stream, keeping a prefix, a suffix, or both
 * ({@link TextRetentionStrategy}). All three strategies share one prefix
 * accumulator and one suffix window: `head` is prefix-only, `tail` is
 * suffix-only, `headTail` is both.
 *
 * Bytes, not characters. {@link finish} trims a partial codepoint at each cut
 * so the returned text never introduces a replacement char at the boundary.
 * The suffix window is exactly the bytes finish() reads — at most
 * `prefixCap + suffixCap` in memory.
 */
export class TextRetainer {
  private readonly prefixCap: number
  private readonly suffixCap: number
  private readonly prefixChunks: Uint8Array[] = []
  private prefixHeld = 0
  private suffix = new Uint8Array(0)
  private total = 0

  /** @param strategy One {@link TextRetentionStrategy} variant; byte budgets must be non-negative integers. */
  constructor(strategy: TextRetentionStrategy) {
    switch (strategy.kind) {
      case 'head':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this.prefixCap = strategy.maxBytes
        this.suffixCap = 0
        break
      case 'tail':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this.prefixCap = 0
        this.suffixCap = strategy.maxBytes
        break
      case 'headTail':
        assertBudget(strategy.headBytes, 'headBytes')
        assertBudget(strategy.tailBytes, 'tailBytes')
        this.prefixCap = strategy.headBytes
        this.suffixCap = strategy.tailBytes
        break
    }
  }

  /**
   * Offer one chunk (a `Uint8Array`, or a `string` encoded as UTF-8). Prefix
   * bytes fill up to the prefix cap then stop; the suffix is reset to the last
   * `suffixLenAt(total)` bytes of the stream so far. `kept` is `true` only when
   * no byte of this chunk was dropped.
   *
   * @param chunk The next bytes of the stream (`Uint8Array` or UTF-8 `string`).
   * @returns The per-push {@link PushDecision}.
   */
  push(chunk: Uint8Array | string): PushDecision {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    const before = this.total
    this.total += bytes.length

    const room = this.prefixCap - this.prefixHeld
    const take = Math.max(0, Math.min(room, bytes.length))
    this.prefixChunks.push(bytes.subarray(0, take))
    this.prefixHeld += take

    const keep = this.suffixLenAt(this.total)
    const combined = concat([this.suffix, bytes])
    this.suffix = Uint8Array.from(combined.subarray(combined.length - keep))

    const droppedThisChunk = this.omittedAt(this.total) > this.omittedAt(before)
    return {
      kept: !droppedThisChunk,
      truncated: this.omittedAt(this.total) > 0,
    }
  }

  /** Bytes omitted once `total` bytes have been seen: `total − keptPrefix − keptSuffix`. */
  private omittedAt(total: number): number {
    return total - Math.min(total, this.prefixCap) - this.suffixLenAt(total)
  }

  /** Suffix bytes finish() reads once `total` bytes have been seen. */
  private suffixLenAt(total: number): number {
    const prefixLen = Math.min(total, this.prefixCap)
    return Math.min(total - prefixLen, this.suffixCap)
  }

  /**
   * Finalize: decode the retained prefix and suffix (each trimmed to a UTF-8
   * boundary at its cut) and report the exact omitted byte count.
   *
   * @returns The {@link RetainedText} snapshot (safe to hand to a formatter).
   */
  finish(): RetainedText {
    const prefix = concat(this.prefixChunks)
    const suffix = this.suffix
    const budgetOmitted = this.omittedAt(this.total)
    const [keptPrefix, keptSuffix] = budgetOmitted > 0
      ? [trimTrailingPartialUtf8(prefix), trimLeadingContinuationUtf8(suffix)]
      : [prefix, suffix]
    const text = budgetOmitted > 0
      ? decoder.decode(keptPrefix) + decoder.decode(keptSuffix)
      : decoder.decode(concat([prefix, suffix]))
    const omitted = this.total - keptPrefix.length - keptSuffix.length
    const truncated = omitted > 0
    return {
      text,
      truncated,
      omittedBytes: truncated
        ? { kind: 'exact', count: omitted }
        : { kind: 'none' },
    }
  }
}
