import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  COVERAGE_DEBT_MARKERS,
  STRUCTURAL_EXCLUSIONS,
  coverageExclusions,
  debtFileInventory,
  debtFiles,
  debtInventory,
  exclusionFiles,
  expandBraces,
  redundantCoverageExclusions,
  staleCoverageExclusions,
  staleLaneExclusions,
  unmarkedDebtExclusions,
  unusedDebtMarkers,
  unusedStructuralExclusions,
  vitestConfigSource,
} from './coverage-debt.ts'
import { CONDITIONAL_LANE_ENTRIES } from './vitest-inventory.ts'

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

/** A throwaway package tree: `packages/a/b/src/{x.ts,y.ts,nested/z.tsx}` plus a directory and a symlink. */
async function sourceTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coverage-debt-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const src = join(root, 'packages/a/b/src')
  await mkdir(join(src, 'nested'), { recursive: true })
  await writeFile(join(src, 'x.ts'), 'export const x = 1\n')
  await writeFile(join(src, 'y.ts'), 'export const y = 2\n')
  await writeFile(join(src, 'nested/z.tsx'), 'export const z = 3\n')
  await symlink(join(src, 'x.ts'), join(src, 'linked.ts'), 'file')
  return root
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

  it('keeps every conditional lane entry naming something in the tree', () => {
    expect(staleLaneExclusions()).toEqual([])
  })

  it('names no entry another entry already covers whole', () => {
    // The webworker runtime was excluded twice, once as `src/**` and once as
    // `src/**/*.ts`; the second counted as debt while excluding nothing.
    expect(redundantCoverageExclusions(coverageExclusions(vitestConfigSource()))).toEqual([])
  })

  it('uses every marker it documents', () => {
    expect(unusedDebtMarkers(coverageExclusions(vitestConfigSource()))).toEqual([])
  })

  it('counts the debt in globs and in files so it can be ratcheted down', () => {
    const entries = coverageExclusions(vitestConfigSource())
    const globs = debtInventory(entries)
    const files = debtFileInventory(entries)
    expect(Object.keys(globs).sort()).toEqual([...COVERAGE_DEBT_MARKERS].sort())
    expect(Object.keys(files).sort()).toEqual([...COVERAGE_DEBT_MARKERS].sort())
    for (const marker of COVERAGE_DEBT_MARKERS) {
      // Every glob names at least one file, so the file count is never below the glob count.
      expect(files[marker]).toBeGreaterThanOrEqual(globs[marker] ?? Number.POSITIVE_INFINITY)
    }
  })
})

describe('coverageExclusions', () => {
  it('attributes each glob to the comment block above it', () => {
    expect(coverageExclusions(config(
      noteLine('DEBT(gui): the client lane.'),
      noteLine('A continuation line keeps the marker.'),
      globLine('a.ts'),
      globLine('b.ts'),
    ))).toEqual([
      { glob: 'a.ts', marker: 'DEBT(gui)' },
      { glob: 'b.ts', marker: 'DEBT(gui)' },
    ])
  })

  it('does not let a marker leak into the next comment block', () => {
    // The block that follows a glob is a new one; without this a structural
    // entry inherits the previous block's lane and reads as marked debt.
    expect(coverageExclusions(config(
      noteLine('DEBT(gui): the client lane.'),
      globLine('a.ts'),
      noteLine('Generated code that exists only in lib.'),
      globLine('b.ts'),
    ))).toEqual([
      { glob: 'a.ts', marker: 'DEBT(gui)' },
      { glob: 'b.ts', marker: undefined },
    ])
  })

  it('ends a block at a spread entry', () => {
    expect(coverageExclusions(config(
      noteLine('DEBT(gui): the client lane.'),
      globLine('a.ts'),
      '        ...windowsOnlyCoverageExclusions,',
      globLine('b.ts'),
    ))).toEqual([
      { glob: 'a.ts', marker: 'DEBT(gui)' },
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
      noteLine('DEBT(gui): a deleted surface.'),
      globLine('packages/client/ui-gone/src/Gone.tsx'),
      globLine('packages/*/*/src/oxlint-contract-*.ts'),
      globLine('packages/*/*/src/types.ts'),
    ))
    expect(staleCoverageExclusions(entries)).toEqual(['packages/client/ui-gone/src/Gone.tsx'])
  })

  it('reports a documented marker the list stopped using', () => {
    const entries = coverageExclusions(config(
      noteLine('DEBT(gui): the client lane.'),
      globLine('a.ts'),
    ))
    expect(unusedDebtMarkers(entries)).toEqual(['DEBT(inspector)', 'DEBT(webworker)'])
  })

  it('reports every conditional lane entry when the tree holds none of them', async () => {
    const root = await sourceTree()
    expect(staleLaneExclusions(root)).toEqual([...CONDITIONAL_LANE_ENTRIES])
  })
})

describe('exclusionFiles', () => {
  it('lists files only, follows file symlinks, and expands brace alternations', async () => {
    const root = await sourceTree()
    // `src/**` matches the `nested` directory too; a directory is not a coverage subject.
    expect(exclusionFiles('packages/a/b/src/**', root)).toEqual([
      'packages/a/b/src/linked.ts',
      'packages/a/b/src/nested/z.tsx',
      'packages/a/b/src/x.ts',
      'packages/a/b/src/y.ts',
    ])
    expect(exclusionFiles('packages/a/b/src/{x,y}.ts', root)).toEqual(['packages/a/b/src/x.ts', 'packages/a/b/src/y.ts'])
    expect(exclusionFiles('packages/a/b/src/gone.ts', root)).toEqual([])
  })
})

describe('redundantCoverageExclusions', () => {
  it('flags an entry a broader entry already covers, and the later of two equal entries', async () => {
    const root = await sourceTree()
    const entries = coverageExclusions(config(
      noteLine('DEBT(gui): one file inside the package glob below.'),
      globLine('packages/a/b/src/x.ts'),
      globLine('packages/a/b/src/*'),
      noteLine('DEBT(webworker): the same tree twice.'),
      globLine('packages/a/b/src/**'),
      globLine('packages/a/b/src/**/*.{ts,tsx}'),
    ))
    // `src/*` sits inside `src/**` as well, so it is covered too; `src/**`
    // and `src/**/*.{ts,tsx}` name the same files, and only the later flags.
    expect(redundantCoverageExclusions(entries, root)).toEqual([
      'packages/a/b/src/x.ts',
      'packages/a/b/src/*',
      'packages/a/b/src/**/*.{ts,tsx}',
    ])
  })

  it('leaves overlapping entries alone when neither contains the other, and ignores an empty one', async () => {
    const root = await sourceTree()
    const entries = coverageExclusions(config(
      noteLine('DEBT(gui): two overlapping selections.'),
      globLine('packages/a/b/src/{x,y}.ts'),
      globLine('packages/a/b/src/{y,linked}.ts'),
      globLine('packages/a/b/src/gone.ts'),
    ))
    expect(redundantCoverageExclusions(entries, root)).toEqual([])
  })
})

describe('debtFiles', () => {
  it('lists every hidden file once with each debt glob naming it, skipping structural entries', async () => {
    const root = await sourceTree()
    const entries = coverageExclusions(config(
      globLine('packages/*/*/src/types.ts'),
      noteLine('DEBT(gui): the whole package.'),
      globLine('packages/a/b/src/*'),
      noteLine('DEBT(inspector): one file again.'),
      globLine('packages/a/b/src/y.ts'),
    ))
    expect(debtFiles(entries, root)).toEqual([
      { file: 'packages/a/b/src/linked.ts', marker: 'DEBT(gui)', globs: ['packages/a/b/src/*'] },
      { file: 'packages/a/b/src/x.ts', marker: 'DEBT(gui)', globs: ['packages/a/b/src/*'] },
      { file: 'packages/a/b/src/y.ts', marker: 'DEBT(gui)', globs: ['packages/a/b/src/*', 'packages/a/b/src/y.ts'] },
    ])
    expect(debtFileInventory(entries, root)).toEqual({ 'DEBT(gui)': 3 })
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
