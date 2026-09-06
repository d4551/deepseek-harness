/**
 * Fail-capability and live sweep for the client axe coverage collector.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_PACKAGES_ROOT,
  specAuditsPackageSource,
  specHoldsAxeFloor,
  uiPackagesMissingAxeCoverage,
} from './client-a11y-coverage.ts'

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
    )).toBe(false)
    const dummyRender = `${importLine}import { AppFrame } from '../src/client/AppFrame.tsx'\n`
      + 'const { baseElement } = render(<main><p>Probe</p></main>)\n'
      + "auditSurface('Probe', baseElement)\n"
      + "expect(accessibilityFailures(audits, 100)).toBe('')\n"
    expect(specAuditsPackageSource(`${dummyRender}createElement(AppFrame, props)\n`, 'ui-layout')).toBe(false)
    expect(specAuditsPackageSource(`${dummyRender}<AppFrame />\n`, 'ui-layout')).toBe(false)
    expect(specAuditsPackageSource(`${dummyRender}AppFrame(props)\n`, 'ui-layout')).toBe(false)
    expect(specAuditsPackageSource(`${dummyRender}AppFrame.displayName\n`, 'ui-layout')).toBe(false)
    const notProbe = `${importLine}import { AppFrame } from '../src/client/AppFrame.tsx'\n`
      + "auditSurface('Card', el)\nexpect(accessibilityFailures(audits, 100)).toBe('')\n"
      + 'createElement(AppFrame, props)\n'
    expect(specAuditsPackageSource(notProbe, 'ui-layout')).toBe(false)
    expect(specAuditsPackageSource(
      `${importLine}import { en } from '../src/client/locales.ts'\n`
      + "auditSurface('x', el)\nexpect(accessibilityFailures(audits, 100)).toBe('')\n"
      + 'void en.title\n',
      'ui-layout',
    )).toBe(false)
    expect(specAuditsPackageSource(
      `${importLine}import { AppFrame } from '../src/client/AppFrame.tsx'\n`
      + 'const { baseElement } = render(createElement(AppFrame, props))\n'
      + "auditSurface('AppFrame', baseElement)\n"
      + "expect(accessibilityFailures(audits, 100)).toBe('')\n",
      'ui-layout',
    )).toBe(true)
  })

  it('does not count the ui-layout dummy landmark as package coverage', () => {
    const probe = readFileSync(join(CLIENT_PACKAGES_ROOT, 'ui-layout/tests/probe.a11y.client.spec.tsx'), 'utf8')
    expect(specHoldsAxeFloor(probe)).toBe(true)
    expect(specAuditsPackageSource(probe, 'ui-layout')).toBe(false)
  })

  it('audits every ui-* package that ships TSX', () => {
    expect(
      uiPackagesMissingAxeCoverage(),
      'each ui-* package with src TSX must assert accessibilityFailures after auditSurface against its own source',
    ).toEqual([])
  })
})
