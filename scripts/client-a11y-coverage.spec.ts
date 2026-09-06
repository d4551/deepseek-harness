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
const FLOOR_ARG = /accessibilityFailures\s*\([^;]{0,800}?,\s*(?:100|MINIMUM_ACCESSIBILITY_SCORE|CLIENT_A11Y_FLOOR)\s*,?\s*\)/
const LOWERED_CALL = /accessibilityFailures\s*\([^;]{0,800}?,\s*(?:0|99)\s*,?\s*\)/
const LOWERED_CONST = /(?:MINIMUM_ACCESSIBILITY_SCORE|CLIENT_A11Y_FLOOR)\s*=\s*(?!100\b)\d+/
const FLOOR_EXPECT = /expect\s*\(\s*accessibilityFailures\s*\([^;]{0,800}?\)\s*\)\s*\.to(?:Be|Equal)\(\s*['"]{2}\s*\)/

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
 * Drop block and line comments so a commented-out floor call cannot count.
 * @param source - spec text.
 * @returns comment-free text.
 */
export function stripSpecComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

function namedImports(inner: string): string[] {
  return inner.split(',').map(part => part.trim()).filter(part => part !== '' && !part.startsWith('type ')).map((part) => {
    const renamed = part.split(/\s+as\s+/)
    return (renamed[1] ?? renamed[0] ?? '').trim()
  }).filter(name => name !== '')
}

function srcBindings(source: string, packageName: string): { names: string[]; namespaces: string[] } {
  const names: string[] = []
  const namespaces: string[] = []
  const fromSrc = /import\s+(?!type\b)(?:(\w+)|\{([^}]+)\}|\*\s+as\s+(\w+))\s+from\s+['"](?:\.\.\/)+src[^'"]*['"]/g
  const fromPkg = new RegExp(
    String.raw`import\s+(?!type\b)(?:(\w+)|\{([^}]+)\}|\*\s+as\s+(\w+))\s+from\s+['"]@deepseek-ai/dsh-${packageName}(?:/[^'"]*)?['"]`,
    'g',
  )
  for (const re of [fromSrc, fromPkg]) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(source)) !== null) {
      if (match[1] !== undefined) names.push(match[1])
      if (match[2] !== undefined) names.push(...namedImports(match[2]))
      if (match[3] !== undefined) namespaces.push(match[3])
    }
  }
  return { names, namespaces }
}

function usesBinding(source: string, name: string): boolean {
  const tag = new RegExp(`<${name}[\\s/>]`)
  const element = new RegExp(`createElement\\(\\s*${name}\\b`)
  const call = new RegExp(`\\b${name}\\s*\\(`)
  const member = new RegExp(`\\b${name}\\.`)
  const destructure = new RegExp(`\\}\\s*=\\s*${name}\\b`)
  return tag.test(source) || element.test(source) || call.test(source) || member.test(source) || destructure.test(source)
}

/**
 * Whether a spec holds the axe floor: it must import the harness, run
 * `auditSurface`, and `expect(accessibilityFailures(...)).toBe('')` at 100.
 * Score-only, silent, commented-out, or lowered-floor audits do not count.
 * @param source - spec text.
 * @returns true when the spec can fail on a silent or violating surface at 100.
 */
export function specHoldsAxeFloor(source: string): boolean {
  const text = stripSpecComments(source)
  if (!text.includes(A11Y_IMPORT)) return false
  if (!text.includes('auditSurface(')) return false
  if (LOWERED_CALL.test(text) || LOWERED_CONST.test(text)) return false
  if (!FLOOR_ARG.test(text)) return false
  return FLOOR_EXPECT.test(text)
}

/**
 * Whether a spec that holds the axe floor also audits the package under test.
 *
 * A dummy landmark (`<main><p>Probe</p></main>`) can satisfy
 * {@link specHoldsAxeFloor} without rendering a package export. Coverage
 * requires a `../src` or package-name value import whose binding appears in
 * JSX, `createElement`, a call, or a namespace destructure.
 * @param source - spec text.
 * @param packageName - `ui-*` directory name.
 * @returns true when the spec renders that package's source and holds the floor.
 */
export function specAuditsPackageSource(source: string, packageName: string): boolean {
  if (!specHoldsAxeFloor(source)) return false
  const text = stripSpecComments(source)
  const { names, namespaces } = srcBindings(text, packageName)
  if (names.some(name => usesBinding(text, name))) return true
  if (namespaces.some(name => usesBinding(text, name))) return true
  return false
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

  it('rejects a lowered floor, a commented-out floor, and a dummy landmark', () => {
    const importLine = "import { auditSurface, accessibilityFailures } from '@deepseek-ai/dsh-client-a11y'\n"
    expect(specHoldsAxeFloor(
      `${importLine}auditSurface('x', el)\nexpect(accessibilityFailures(audits, 0)).toBe('')\n`,
    )).toBe(false)
    expect(specHoldsAxeFloor(
      `${importLine}const MINIMUM_ACCESSIBILITY_SCORE = 99\n`
      + "auditSurface('x', el)\nexpect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')\n",
    )).toBe(false)
    expect(specHoldsAxeFloor(
      `${importLine}const CLIENT_A11Y_FLOOR = 0\n`
      + "auditSurface('x', el)\nexpect(accessibilityFailures(audits, CLIENT_A11Y_FLOOR)).toBe('')\n",
    )).toBe(false)
    expect(specHoldsAxeFloor(
      `${importLine}// expect(accessibilityFailures(audits, 100)).toBe('')\n`
      + "auditSurface('x', el)\nexpect(accessibilityScore(audits)).toBe(100)\n",
    )).toBe(false)
    expect(specHoldsAxeFloor(
      `${importLine}auditSurface('x', el)\naccessibilityFailures(audits, 100)\n`,
    )).toBe(false)
    const probe = `${importLine}auditSurface('Probe', el)\nexpect(accessibilityFailures(audits, 100)).toBe('')\n`
    expect(specHoldsAxeFloor(probe)).toBe(true)
    expect(specAuditsPackageSource(probe, 'ui-layout')).toBe(false)
    const dead = `${probe}import { AppFrame } from '../src/client/AppFrame.tsx'\n`
    expect(specAuditsPackageSource(dead, 'ui-layout')).toBe(false)
    expect(specAuditsPackageSource(
      `${dead}createElement(AppFrame, props)\n`,
      'ui-layout',
    )).toBe(true)
  })

  it('does not count the ui-layout dummy landmark as package coverage', () => {
    const probe = readFileSync(join(clientRoot, 'ui-layout/tests/probe.a11y.client.spec.tsx'), 'utf8')
    expect(specHoldsAxeFloor(probe)).toBe(true)
    expect(specAuditsPackageSource(probe, 'ui-layout')).toBe(false)
  })

  it('audits every ui-* package that ships TSX', () => {
    const missing = uiPackagesWithTsx().filter(name => !packageAuditsAxe(name))
    expect(missing, 'each ui-* package with src TSX must assert accessibilityFailures after auditSurface against its own source').toEqual([])
  })
})
