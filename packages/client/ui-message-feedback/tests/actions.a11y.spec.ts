/**
 * Host-program pointer: the rating-control axe audit imports TSX, so it lives
 * on the client face (`message-feedback.a11y.client.spec.tsx`). This file must
 * not import TSX because tsconfig.host.json has no jsx.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('message feedback a11y face placement', () => {
  it('keeps the axe audit on the client program', () => {
    const sibling = join(dirname(fileURLToPath(import.meta.url)), 'message-feedback.a11y.client.spec.tsx')
    expect(existsSync(sibling)).toBe(true)
  })
})
