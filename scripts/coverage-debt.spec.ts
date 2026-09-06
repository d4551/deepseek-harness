import { describe, expect, it } from 'vitest'
import {
  COVERAGE_DEBT_MARKERS,
  STRUCTURAL_EXCLUSIONS,
  coverageExclusions,
  debtInventory,
  expandBraces,
  staleCoverageExclusions,
  unmarkedDebtExclusions,
  unusedDebtMarkers,
  unusedStructuralExclusions,
  vitestConfigSource,
} from './coverage-debt.ts'

function config(...lines: string[]): string {
  return `export default { test: { coverage: {\n      exclude: [\n${lines.join('\n')}\n      ],\n    } } }\n`
}

/** One exclusion line as the config writes it. */
function globLine(glob: string): string {
  return `        '${glob}',`
}

/** One comment line as the config writes it. */
function noteLine(text: string): string {
  return `        // ${text}`
}

describe('the live coverage exclusion list', () => {
  it('marks every debt exclusion with the lane it waits on', () => {
    // docs/testing.md tells a reader the debt carries these markers. It said so
    // while none existed anywhere in the tree; this is what makes that true.
    expect(unmarkedDebtExclusions(coverageExclusions(vitestConfigSource()))).toEqual([])
  })

  it('carries every structural glob this file classifies', () => {
    expect(unusedStructuralExclusions(coverageExclusions(vitestConfigSource()))).toEqual([])
  })

  it('excludes nothing that no longer exists', () => {
    // Five entries named paths deleted or renamed out of the tree, exempting
    // nothing while still reading as an exemption.
    expect(staleCoverageExclusions(coverageExclusions(vitestConfigSource()))).toEqual([])
  })

  it('uses every marker it documents', () => {
    expect(unusedDebtMarkers(coverageExclusions(vitestConfigSource()))).toEqual([])
  })

  it('counts the debt so it can be ratcheted down', () => {
    const inventory = debtInventory(coverageExclusions(vitestConfigSource()))
    expect(Object.keys(inventory).sort()).toEqual([...COVERAGE_DEBT_MARKERS].sort())
    for (const marker of COVERAGE_DEBT_MARKERS) expect(inventory[marker]).toBeGreaterThan(0)
  })
})

describe('coverageExclusions', () => {
  it('attributes each glob to the comment block above it', () => {
    expect(coverageExclusions(config(
      noteLine('TODO(gui): the client lane.'),
      noteLine('A continuation line keeps the marker.'),
      globLine('a.ts'),
      globLine('b.ts'),
    ))).toEqual([
      { glob: 'a.ts', marker: 'TODO(gui)' },
      { glob: 'b.ts', marker: 'TODO(gui)' },
    ])
  })

  it('does not let a marker leak into the next comment block', () => {
    // The block that follows a glob is a new one; without this a structural
    // entry inherits the previous block's lane and reads as marked debt.
    expect(coverageExclusions(config(
      noteLine('TODO(gui): the client lane.'),
      globLine('a.ts'),
      noteLine('Generated code that exists only in lib.'),
      globLine('b.ts'),
    ))).toEqual([
      { glob: 'a.ts', marker: 'TODO(gui)' },
      { glob: 'b.ts', marker: undefined },
    ])
  })

  it('ends a block at a spread entry', () => {
    expect(coverageExclusions(config(
      noteLine('TODO(gui): the client lane.'),
      globLine('a.ts'),
      '        ...windowsOnlyCoverageExclusions,',
      globLine('b.ts'),
    ))).toEqual([
      { glob: 'a.ts', marker: 'TODO(gui)' },
      { glob: 'b.ts', marker: undefined },
    ])
  })

  it('rejects a config whose coverage exclude list it cannot read', () => {
    expect(() => coverageExclusions('export default {}')).toThrow(/declares no coverage block/)
    expect(() => coverageExclusions('coverage: {')).toThrow(/declares no exclude list/)
    expect(() => coverageExclusions('coverage: {\n exclude: [')).toThrow(/unterminated/)
  })
})

describe('injected exclusion-list misses', () => {
  it('reports a debt exclusion nothing marks', () => {
    const entries = coverageExclusions(config(globLine('packages/client/ui-new/src/Thing.tsx')))
    expect(unmarkedDebtExclusions(entries)).toEqual(['packages/client/ui-new/src/Thing.tsx'])
  })

  it('accepts an unmarked glob this file classifies as structural', () => {
    const entries = coverageExclusions(config(globLine(STRUCTURAL_EXCLUSIONS[0] ?? '')))
    expect(unmarkedDebtExclusions(entries)).toEqual([])
  })

  it('reports a structural classification the config dropped', () => {
    const entries = coverageExclusions(config(globLine('packages/client/ui-new/src/Thing.tsx')))
    expect(unusedStructuralExclusions(entries)).toEqual([...STRUCTURAL_EXCLUSIONS])
  })

  it('reports a glob that matches nothing, and spares the named transient', () => {
    const entries = coverageExclusions(config(
      noteLine('TODO(gui): a deleted surface.'),
      globLine('packages/client/ui-gone/src/Gone.tsx'),
      globLine('packages/*/*/src/oxlint-contract-*.ts'),
      globLine('packages/*/*/src/types.ts'),
    ))
    expect(staleCoverageExclusions(entries)).toEqual(['packages/client/ui-gone/src/Gone.tsx'])
  })

  it('reports a documented marker the list stopped using', () => {
    const entries = coverageExclusions(config(
      noteLine('TODO(gui): the client lane.'),
      globLine('a.ts'),
    ))
    expect(unusedDebtMarkers(entries)).toEqual(['TODO(inspector)', 'TODO(webworker)'])
  })
})

describe('expandBraces', () => {
  it('expands each alternation so a braced glob is matched, not read as empty', () => {
    // Node's glob has no brace expansion, so an unexpanded alternation matches
    // nothing and every braced exclusion would report as stale.
    expect(expandBraces('src/{a,b}.ts')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(expandBraces('src/{a,b}/{c,d}.ts'))
      .toEqual(['src/a/c.ts', 'src/a/d.ts', 'src/b/c.ts', 'src/b/d.ts'])
    expect(expandBraces('src/plain.ts')).toEqual(['src/plain.ts'])
  })
})
