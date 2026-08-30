/**
 * The testing policy says every client UI package that ships TSX is held to
 * axe-core. A prose list of audited packages went stale; this asserts the
 * import exists in that package's own tests so a new ui-* surface cannot
 * ship without an audit.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const clientRoot = join(import.meta.dirname, '../packages/client')
const A11Y_IMPORT = "from '@deepseek-ai/dsh-client-a11y'"

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
}

function uiPackagesWithTsx(): string[] {
  return readdirSync(clientRoot).filter((name) => {
    if (!name.startsWith('ui-')) return false
    const src = join(clientRoot, name, 'src')
    if (!existsSync(src)) return false
    return filesUnder(src).some(path => path.endsWith('.tsx'))
  }).sort()
}

/**
 * Whether a spec holds the axe floor: it must import the harness, run
 * `auditSurface`, and assert `accessibilityFailures`. Score-only or silent
 * audits do not count.
 * @param source - spec text.
 * @returns true when the spec can fail on a silent or violating surface.
 */
export function specHoldsAxeFloor(source: string): boolean {
  return source.includes(A11Y_IMPORT)
    && source.includes('auditSurface(')
    && source.includes('accessibilityFailures(')
}

function packageAuditsAxe(name: string): boolean {
  const tests = join(clientRoot, name, 'tests')
  if (!existsSync(tests)) return false
  return filesUnder(tests).some((path) => {
    if (!path.includes('.spec.')) return false
    return specHoldsAxeFloor(readFileSync(path, 'utf8'))
  })
}

describe('client UI axe coverage', () => {
  it('rejects a spec that audits without accessibilityFailures', () => {
    expect(specHoldsAxeFloor(
      "import { auditSurface, accessibilityScore } from '@deepseek-ai/dsh-client-a11y'\n"
      + 'expect(accessibilityScore(audits)).toBe(100)\n',
    )).toBe(false)
    expect(specHoldsAxeFloor(
      "import { auditSurface, accessibilityFailures } from '@deepseek-ai/dsh-client-a11y'\n"
      + "auditSurface('x', el)\nexpect(accessibilityFailures(audits, 100)).toBe('')\n",
    )).toBe(true)
  })

  it('audits every ui-* package that ships TSX', () => {
    const missing = uiPackagesWithTsx().filter(name => !packageAuditsAxe(name))
    expect(missing, 'each ui-* package with src TSX must assert accessibilityFailures after auditSurface').toEqual([])
  })
})
