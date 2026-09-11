/** Verdict syntax cannot promote quoted, partial, or multiline text to approval. */

import { expect, it } from 'vitest'
import { parseVerdict } from '../src/protocol.ts'

it.each(['ALLOW', 'DENY'])('preserves the decisive reason for %s', (verdict) => {
  expect(parseVerdict(`VERDICT: ${verdict}\nREASON: direct authorization`)).toEqual({
    verdict: verdict === 'ALLOW' ? 'allowed' : 'denied', reason: 'direct authorization',
  })
})

it.each([
  '', 'VERDICT: ALLOW', 'VERDICT: ALLOW\n', 'VERDICT: ALLOW\nREASON: ',
  'VERDICT: ALLOW\nREASON: \t ', 'VERDICT: ALLOW\nREASON: a\rb',
  'VERDICT: ALLOW\nREASON: a\u2028b', 'VERDICT: ALLOW\nREASON: a\u2029b',
  'VERDICT: ALLOW\nREASON: a\n', 'VERDICT: ALLOW\nreason: a',
  'VERDICT: ALLOW\nREASON:a', 'VERDICT: ALLOW\nwrong: a',
  'VERDICT: DENY\nREASON: a\nVERDICT: ALLOW', '\nVERDICT: ALLOW\nREASON: a',
])('rejects the complete malformed output %j', (text) => {
  expect(parseVerdict(text)).toEqual({ verdict: 'unavailable', reason: 'review model did not follow the exact two-line verdict protocol' })
})
