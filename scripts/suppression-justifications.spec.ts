/**
 * Suppression justification scan: injected violations fail the collector, and
 * the live package tree is a second case rather than the only one.
 */
import { describe, expect, it } from 'vitest'
import { loadSuppressionCorpus, scanSuppressions } from './suppression-justifications.ts'

const MINIMUM_SCANNED_SOURCES = 900

describe('scanSuppressions', () => {
  it('rejects a lint directive that states no reason', () => {
    const violations = scanSuppressions([{
      file: 'packages/x/y/src/index.ts',
      content: [
        'const rows = [1]',
        '// oxlint-disable-next-line typescript/no-non-null-assertion',
        'export const first = rows[0]!',
        '',
      ].join('\n'),
    }])

    expect(violations).toEqual([{
      file: 'packages/x/y/src/index.ts',
      line: 2,
      kind: 'lint-directive',
      text: '// oxlint-disable-next-line typescript/no-non-null-assertion',
    }])
  })

  it('accepts a reason written after the rule or above the run of directives', () => {
    const inline = scanSuppressions([{
      file: 'packages/x/y/src/inline.ts',
      content: '// oxlint-disable-next-line typescript/unbound-method -- literal methods ignore `this`\nexport const run = 1\n',
    }])
    const grouped = scanSuppressions([{
      file: 'packages/x/y/src/grouped.ts',
      content: [
        '// Object-literal methods do not use `this`.',
        '// oxlint-disable-next-line typescript/unbound-method',
        'const a = 1',
        '// oxlint-disable-next-line typescript/unbound-method',
        'const b = 2',
        '',
      ].join('\n'),
    }])

    expect([...inline, ...grouped]).toEqual([])
  })

  it('rejects an empty catch and accepts one that names what it swallows', () => {
    const bare = scanSuppressions([{
      file: 'packages/x/y/src/bare.ts',
      content: 'export function run() {\n  try { risky() } catch {}\n}\n',
    }])
    const named = scanSuppressions([{
      file: 'packages/x/y/src/named.ts',
      content: [
        'export function run() {',
        '  try { risky() } catch {',
        '    // The probe is advisory; a missing binary is the answer, not a fault.',
        '  }',
        '}',
        '',
      ].join('\n'),
    }])

    expect(bare).toEqual([{
      file: 'packages/x/y/src/bare.ts',
      line: 2,
      kind: 'empty-catch',
      text: 'catch {}',
    }])
    expect(named).toEqual([])
  })

  it('leaves a catch that handles the failure alone', () => {
    expect(scanSuppressions([{
      file: 'packages/x/y/src/handled.ts',
      content: 'export function run() {\n  try { risky() } catch (error) {\n    report(error)\n  }\n}\n',
    }])).toEqual([])
  })
})

describe('shipped package source', () => {
  it('states a reason for every lint suppression and every empty catch', () => {
    const corpus = loadSuppressionCorpus()
    expect(corpus.length).toBeGreaterThan(MINIMUM_SCANNED_SOURCES)

    expect(scanSuppressions(corpus)).toEqual([])
  })
})
