/**
 * The installable-version gate reports what it claims to, in both directions.
 *
 * Driven against fixed `bun outdated` output rather than the live registry: a
 * case that resolved real versions would pass or fail on what npm published
 * that morning, which is a test of the network.
 */

import { describe, expect, it } from 'vitest'
import { behindInstallable, heldByPolicy, parseOutdated } from './verify-installable-versions.ts'

/**
 * A table with one package behind, two held, and one already newest.
 *
 * The `Update` column is what the declared range admits, so for an exactly
 * pinned dependency it equals `Current` even when a newer version exists —
 * which is why knip reads 6.33.0 there while 6.34.0 is published, and why a
 * check against that column could never fire.
 */
const TABLE = `bun outdated v1.4.0 (34cbb9a40)
|---------------------------------------------------|
| Package           | Current | Update   | Latest   |
|-------------------|---------|----------|----------|
| @types/node (dev) | 26.4.0  | 26.4.0 * | 26.4.0 * |
|-------------------|---------|----------|----------|
| knip (dev)        | 6.33.0  | 6.33.0   | 6.34.0   |
|-------------------|---------|----------|----------|
| oxlint (dev)      | 1.80.0  | 1.80.0   | 1.81.0 * |
|-------------------|---------|----------|----------|
| vite (peer)       | 8.2.2   | 8.2.2    | 8.2.2    |
|---------------------------------------------------|
Note: The * indicates that version isn't true latest due to minimum release age
`

describe('installable versions', () => {
  it('reads every row and no rule, header or note', () => {
    expect(parseOutdated(TABLE).map(row => row.name)).toEqual(['@types/node', 'knip', 'oxlint', 'vite'])
  })

  it('reports a package behind a version it could install today', () => {
    expect(behindInstallable(parseOutdated(TABLE))).toEqual(['knip is at 6.33.0 and 6.34.0 is installable now'])
  })

  it('does not report a package the supply-chain hold is withholding', () => {
    // oxlint's newest is 1.81.0 and the hold keeps it at 1.80.0. Reporting it
    // would make the gate demand a bypass of this repository's own policy.
    const behind = behindInstallable(parseOutdated(TABLE))
    expect(behind.some(line => line.startsWith('oxlint'))).toBe(false)
    expect(heldByPolicy(parseOutdated(TABLE))).toEqual(['@types/node 26.4.0', 'oxlint 1.80.0'])
  })

  it('says nothing about a package already at the newest version', () => {
    expect(behindInstallable(parseOutdated(TABLE)).some(line => line.startsWith('vite'))).toBe(false)
  })

  it('reads an empty report as nothing outdated', () => {
    expect(parseOutdated('bun outdated v1.4.0\n')).toEqual([])
    expect(behindInstallable([])).toEqual([])
  })
})
