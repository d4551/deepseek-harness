/**
 * Host-program pointer: the AppFrame axe audit imports TSX, so it lives on the
 * client face (`app-frame.a11y.client.spec.ts`). This file must not import TSX
 * because tsconfig.host.json has no jsx.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('app frame a11y face placement', () => {
  it('keeps the axe audit on the client program', () => {
    const sibling = join(dirname(fileURLToPath(import.meta.url)), 'app-frame.a11y.client.spec.ts')
    expect(existsSync(sibling)).toBe(true)
  })
})
