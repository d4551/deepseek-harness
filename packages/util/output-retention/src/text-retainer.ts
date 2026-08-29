/**
 * Byte-oriented bounded text retention with UTF-8-safe cuts.
 * @module @deepseek-ai/dsh-output-retention/text-retainer
 */
import { assertBudget } from './budget.ts'
import type { Omitted, PushDecision, RetainedText, TextRetentionStrategy } from './index.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder() // utf-8, non-fatal: internal malformed bytes → U+FFFD

/**
 * Drop a trailing incomplete UTF-8 sequence so a prefix cut never emits a
 * replacement char at the boundary. Walks back over continuation bytes
 * (`10xxxxxx`) to the lead byte; if fewer bytes follow it than the lead byte's
 * length declares, the sequence is incomplete and is trimmed. A complete tail,
 * or a run too long/short to be a valid lead, is returned untouched (any
 * genuinely malformed interior is left for the decoder to replace).
 */
function trimTrailingPartialUtf8(bytes: Uint8Array): Uint8Array {
  let i = bytes.length - 1
  // Continuation bytes are 0b10xxxxxx; scan back at most 3 (max sequence is 4).
  // Indices are bounds-checked by the loop guard, so the reads are in range.
  while (i >= 0 && ((bytes[i] as number) & 0xc0) === 0x80 && bytes.length - i <= 3) i--
  if (i < 0) return bytes
  const lead = bytes[i] as number
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0
  // expected 0 → not a lead byte (stray continuation / invalid): leave it.
  if (expected === 0) return bytes
  return bytes.length - i < expected ? bytes.subarray(0, i) : bytes
}

/**
 * Drop leading continuation bytes (`10xxxxxx`) so a suffix cut starts on a
 * lead/ASCII byte instead of mid-codepoint.
 */
function trimLeadingContinuationUtf8(bytes: Uint8Array): Uint8Array {
  let i = 0
  // i < length guards the read.
  while (i < bytes.length && ((bytes[i] as number) & 0xc0) === 0x80) i++
  return bytes.subarray(i)
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
 * ({@link TextRetentionStrategy}). All three strategies share one prefix/suffix
 * accumulator: `head` is prefix-only, `tail` is suffix-only, `headTail` is both.
 *
 * Bytes, not characters: caps and `omittedBytes` are byte counts for process/
 * body safety. Chunks that straddle a codepoint are handled — {@link finish}
 * trims a partial codepoint at each cut so the returned text never introduces a
 * replacement char at the boundary. Each side retains exactly the bytes
 * {@link finish} reads — at most `prefixCap + suffixCap` in memory — so
 * neither a large stream nor a single chunk larger than a window
 * accumulates unbounded.
 */
export class TextRetainer {
  private readonly prefixCap: number
  private readonly suffixCap: number
  private readonly prefixChunks: Uint8Array[] = []
  private prefixHeld = 0
  private readonly suffixChunks: Uint8Array[] = []
  private suffixHeld = 0
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
   * bytes fill up to the prefix cap then stop; suffix bytes roll so only the
   * window {@link finish} reads is retained. `kept` is `true` only when no byte
   * of this chunk was dropped.
   *
   * @param chunk The next bytes of the stream (`Uint8Array` or UTF-8 `string`).
   * @returns The per-push {@link PushDecision}.
   */
  push(chunk: Uint8Array | string): PushDecision {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    const before = this.total
    this.total += bytes.length

    // Prefix: take only up to the cap; the rest of this chunk is "not prefixed".
    const room = this.prefixCap - this.prefixHeld
    const take = Math.max(0, Math.min(room, bytes.length))
    if (take > 0) {
      this.prefixChunks.push(bytes.subarray(0, take))
      this.prefixHeld += take
    }

    // Suffix: append the chunk, then retain exactly the bytes finish() reads —
    // the last `suffixLenAt(total)` of the stream. The window never moves
    // backward (prefixLen stops at its cap; suffixLen only grows), so bytes
    // dropped here can never re-enter it. Retaining exactly the window is what
    // bounds memory, including a single chunk larger than the window.
    if (this.suffixCap > 0) {
      this.suffixChunks.push(bytes)
      this.suffixHeld += bytes.length
      let excess = this.suffixHeld - this.suffixLenAt(this.total)
      let head = this.suffixChunks[0]
      while (head !== undefined && excess >= head.length) {
        this.suffixChunks.shift()
        this.suffixHeld -= head.length
        excess -= head.length
        head = this.suffixChunks[0]
      }
      // The head chunk now holds fewer excess bytes than its own length; slice
      // exactly those off. (head.length > excess by the loop guard, so the
      // slice is non-empty.)
      if (head !== undefined && excess > 0) {
        this.suffixChunks[0] = head.subarray(excess)
        this.suffixHeld -= excess
      }
    }

    // Dropped = bytes that no side can keep. Compute cumulative omission the
    // SAME way finish() does (via omittedAt), so push and finish never disagree;
    // per-push we only need whether THIS chunk pushed the total past what the
    // two caps hold.
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

  /** Suffix bytes finish() reads once `total` bytes have been seen: `min(total − prefixLen, suffixCap)`. */
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
    // Each accumulator holds exactly the bytes this method reads: the prefix
    // took only up to its cap, and push() trimmed the suffix to the window.
    const prefix = concat(this.prefixChunks) // exactly min(total, prefixCap) bytes
    const suffix = concat(this.suffixChunks) // exactly suffixLenAt(total) bytes

    // With nothing omitted by budget, prefix and suffix are ADJACENT slices of
    // one stream (prefixLen + suffixLen === total), so the head|tail split is
    // artificial: a codepoint may span it. Decode the contiguous whole as one
    // buffer — trimming or decoding the halves separately here would corrupt a
    // boundary-spanning codepoint though no content was dropped. Only a real
    // omitted gap makes each side a true cut: trim each to a UTF-8 boundary and
    // decode separately so a codepoint is never reconstructed across the gap.
    const budgetOmitted = this.omittedAt(this.total)
    const [keptPrefix, keptSuffix] = budgetOmitted > 0
      ? [trimTrailingPartialUtf8(prefix), trimLeadingContinuationUtf8(suffix)]
      : [prefix, suffix]
    const text = budgetOmitted > 0
      ? decoder.decode(keptPrefix) + decoder.decode(keptSuffix)
      : decoder.decode(concat([prefix, suffix]))

    // Report omission against the bytes ACTUALLY returned, not the pre-trim
    // budget: a boundary trim drops partial-codepoint bytes too, so an exact
    // count derived from the budget alone would overstate the retained text (and
    // any "Omitted N bytes" notice built from it would be a lie).
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
