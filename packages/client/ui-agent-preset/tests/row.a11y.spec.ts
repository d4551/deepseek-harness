/**
 * Host-program pointer: the AgentPresetRow axe audit imports TSX, so it lives
 * on the client face (`row.a11y.client.spec.ts`). This file must not import TSX
 * because tsconfig.host.json has no jsx.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('agent preset a11y face placement', () => {
  it('keeps the axe audit on the client program', () => {
    const sibling = join(dirname(fileURLToPath(import.meta.url)), 'row.a11y.client.spec.ts')
    expect(existsSync(sibling)).toBe(true)
  })
})
