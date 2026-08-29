import { describe, expect, it } from 'vitest'
import {
  describeOmitted,
  formatRetentionNotice,
  type Omitted,
  type RetentionNotice,
} from '@deepseek-ai/dsh-output-retention'

describe('describeOmitted — false precision safety', () => {
  it('prints an exact count for exact omission', () => {
    expect(describeOmitted({ kind: 'exact', count: 3 }, 'items')).toBe('Omitted 3 items.')
    expect(describeOmitted({ kind: 'exact', count: 12 }, 'bytes')).toBe('Omitted 12 bytes.')
  })

  it('prints NO count for unknown omission', () => {
    expect(describeOmitted({ kind: 'unknown' }, 'lines')).toBe('More lines were omitted.')
  })

  it('returns empty string when nothing was omitted', () => {
    expect(describeOmitted({ kind: 'none' }, 'chars')).toBe('')
  })
})

describe('formatRetentionNotice', () => {
  const notice = (omitted: Omitted): RetentionNotice => ({
    scope: 'grep',
    strategy: 'head',
    unit: 'items',
    limit: 100,
    kept: 100,
    omitted,
  })

  it('joins the standardized omission clause with the tool recovery guidance', () => {
    const out = formatRetentionNotice(
      notice({ kind: 'exact', count: 25 }),
      ({ kept }) => `Results capped at ${kept}. Narrow the pattern, path, or include to see more.`,
    )
    expect(out).toBe('Omitted 25 items. Results capped at 100. Narrow the pattern, path, or include to see more.')
  })

  it('omits the empty half when nothing was omitted', () => {
    const out = formatRetentionNotice(notice({ kind: 'none' }), () => 'Recovery text.')
    expect(out).toBe('Recovery text.')
  })

  it('omits the empty half when the tool supplies no recovery text', () => {
    const out = formatRetentionNotice(notice({ kind: 'exact', count: 2 }), () => '')
    expect(out).toBe('Omitted 2 items.')
  })

  it('passes the full notice to the recovery builder (limit as a head/tail pair)', () => {
    const headTail: RetentionNotice = {
      scope: 'bash stdout',
      strategy: 'headTail',
      unit: 'bytes',
      limit: { head: 2_000, tail: 2_000 },
      kept: 4_000,
      omitted: { kind: 'exact', count: 500 },
    }
    const out = formatRetentionNotice(headTail, n =>
      typeof n.limit === 'object' ? `Kept ${n.limit.head}B head + ${n.limit.tail}B tail.` : '')
    expect(out).toBe('Omitted 500 bytes. Kept 2000B head + 2000B tail.')
  })
})
