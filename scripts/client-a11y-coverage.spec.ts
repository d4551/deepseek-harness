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
const FLOOR_CALL = /accessibilityFailures\s*\([\s\S]{0,800}?,\s*(?:100|MINIMUM_ACCESSIBILITY_SCORE|CLIENT_A11Y_FLOOR)\s*,?\s*\)/
const LOWERED_CALL = /accessibilityFailures\s*\([\s\S]{0,800}?,\s*(?:0|99)\s*,?\s*\)/
const LOWERED_CONST = /MINIMUM_ACCESSIBILITY_SCORE\s*=\s*(?!100\b)\d+/

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
 * `auditSurface`, and assert `accessibilityFailures` at 100. Score-only,
 * silent, or lowered-floor audits do not count.
 * @param source - spec text.
 * @returns true when the spec can fail on a silent or violating surface at 100.
 */
export function specHoldsAxeFloor(source: string): boolean {
  if (!source.includes(A11Y_IMPORT)) return false
  if (!source.includes('auditSurface(')) return false
  if (LOWERED_CALL.test(source) || LOWERED_CONST.test(source)) return false
  return FLOOR_CALL.test(source)
}

/**
 * Whether a spec that holds the axe floor also audits the package under test.
 *
 * A dummy landmark (`<main><p>Probe</p></main>`) can satisfy
 * {@link specHoldsAxeFloor} without ever importing the package. Coverage
 * requires a `../src` or package-name import so deleting the real audit
 * cannot hide behind a probe.
 * @param source - spec text.
 * @param packageName - `ui-*` directory name.
 * @returns true when the spec imports that package's source and holds the floor.
 */
export function specAuditsPackageSource(source: string, packageName: string): boolean {
  if (!specHoldsAxeFloor(source)) return false
  if (/from\s+['"]\.\.\/src/.test(source)) return true
  const fromPkg = new RegExp(`from\\s+['"]@deepseek-ai/dsh-${packageName}(?:/|['"])`)
  return fromPkg.test(source)
}

function packageAuditsAxe(name: string): boolean {
  const tests = join(clientRoot, name, 'tests')
  if (!existsSync(tests)) return false
  return filesUnder(tests).some((path) => {
    if (!path.includes('.spec.')) return false
    return specAuditsPackageSource(readFileSync(path, 'utf8'), name)
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

  it('rejects a lowered floor and a dummy landmark that never imports the package', () => {
    const importLine = "import { auditSurface, accessibilityFailures } from '@deepseek-ai/dsh-client-a11y'\n"
    expect(specHoldsAxeFloor(
      `${importLine}auditSurface('x', el)\nexpect(accessibilityFailures(audits, 0)).toBe('')\n`,
    )).toBe(false)
    expect(specHoldsAxeFloor(
      `${importLine}const MINIMUM_ACCESSIBILITY_SCORE = 99\n`
      + "auditSurface('x', el)\nexpect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')\n",
    )).toBe(false)
    const probe = `${importLine}auditSurface('Probe', el)\nexpect(accessibilityFailures(audits, 100)).toBe('')\n`
    expect(specHoldsAxeFloor(probe)).toBe(true)
    expect(specAuditsPackageSource(probe, 'ui-layout')).toBe(false)
    expect(specAuditsPackageSource(
      `${probe}import { AppFrame } from '../src/client/AppFrame.tsx'\n`,
      'ui-layout',
    )).toBe(true)
  })

  it('audits every ui-* package that ships TSX', () => {
    const missing = uiPackagesWithTsx().filter(name => !packageAuditsAxe(name))
    expect(missing, 'each ui-* package with src TSX must assert accessibilityFailures after auditSurface against its own source').toEqual([])
  })
})
