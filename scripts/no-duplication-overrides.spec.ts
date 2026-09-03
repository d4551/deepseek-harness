/**
 * The duplication gate has no in-file escape. Injected fixtures prove each
 * marker form is reported; the live tree is scanned as well, so a clean tree is
 * not the only passing case.
 */
import { describe, expect, it } from 'vitest'
import { auditDuplicationOverrides, overrideCandidateFiles, scanDuplicationOverrides } from './no-duplication-overrides.ts'

/** Assembled from parts so this spec is subject to the ban it tests. */
const START = ['/* jscpd', ':ignore-start */'].join('')
const END = ['/* jscpd', ':ignore-end */'].join('')

describe('injected overrides', () => {
  it('reports a bare start marker', () => {
    expect(scanDuplicationOverrides('packages/a/b/src/x.ts', `${START}\nconst a = 1\n${END}\n`))
      .toEqual([
        { file: 'packages/a/b/src/x.ts', line: 1, text: START },
        { file: 'packages/a/b/src/x.ts', line: 3, text: END },
      ])
  })

  it('reports a marker that carries a reason, which jscpd honours the same way', () => {
    // The config regex matches only the bare form, so a first reading concluded
    // the reasoned form suppressed nothing. jscpd's own marker handling accepts
    // both; measured on a two-file fixture, the reasoned form suppressed a real
    // clone. A reason changes what a reader learns, not what the tool does.
    const reasoned = ['/* jscpd', ':ignore-start -- deliberate twin, see the Agent Note */'].join('')
    expect(scanDuplicationOverrides('packages/a/b/src/x.ts', `${reasoned}\n`).map(finding => finding.line)).toEqual([1])
  })

  it('reports a marker a generator emits into what it writes', () => {
    // The ban reaches the generated file through its generator: two of them
    // wrote markers into catalogs this way.
    const emitted = `lines.push('${START}')\n`
    expect(scanDuplicationOverrides('scripts/gen-thing.ts', emitted).map(finding => finding.line)).toEqual([1])
  })

  it('leaves a source that merely names the tool alone', () => {
    const prose = '// clone detection stays with the jscpd `duplication` gate\nconst jscpd = { major: 5 }\n'
    expect(scanDuplicationOverrides('scripts/x.ts', prose)).toEqual([])
  })
})

describe('live tree', () => {
  const files = overrideCandidateFiles()

  it('scans a real corpus rather than an empty one', () => {
    expect(files.length).toBeGreaterThan(1000)
    expect(files.some(entry => entry.file.startsWith('packages/core/'))).toBe(true)
  })

  it('holds no duplication override', () => {
    expect(auditDuplicationOverrides()).toEqual([])
  })
})
