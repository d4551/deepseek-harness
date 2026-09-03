/**
 * The corpus every source-plane gate scans. `isEmittedOrVendored` is the one
 * predicate that decides what a gate may judge, so its exclusions are proved
 * here rather than restated in each gate's own live-tree block.
 */
import { describe, expect, it } from 'vitest'
import { isEmittedOrVendored, uniqueRepoFiles } from './repo-files.ts'

describe('isEmittedOrVendored', () => {
  it('excludes emitted output, which is built from the sources a gate already judges', () => {
    expect(isEmittedOrVendored('packages/core/session/lib/index.js')).toBe(true)
    expect(isEmittedOrVendored('packages/core/session/lib/types/index.d.ts')).toBe(true)
    expect(isEmittedOrVendored('packages/web/web-fetch-playwright/node_modules/playwright/index.js')).toBe(true)
  })

  it('excludes vendored sources, which this repository does not author', () => {
    expect(isEmittedOrVendored('vendor/cordis/packages/core/src/context.ts')).toBe(true)
  })

  it('admits authored sources, including a path whose name merely resembles an excluded one', () => {
    expect(isEmittedOrVendored('packages/core/session/src/index.ts')).toBe(false)
    expect(isEmittedOrVendored('scripts/no-barrels.ts')).toBe(false)
    // `vendor/` is a root prefix and `/lib/` a whole segment: a package named
    // for either is authored source and must still be judged.
    expect(isEmittedOrVendored('packages/util/vendor-manifest/src/index.ts')).toBe(false)
    expect(isEmittedOrVendored('packages/util/libsql/src/index.ts')).toBe(false)
  })
})

describe('uniqueRepoFiles', () => {
  const files = uniqueRepoFiles(
    new URL('..', import.meta.url).pathname,
    ['packages/**/*.ts', 'scripts/**/*.ts'],
    isEmittedOrVendored,
  )

  it('reads a real corpus rather than passing on an empty glob', () => {
    expect(files.length).toBeGreaterThan(1000)
  })

  it('applies the exclusion to the live tree, which does hold emitted and vendored files', () => {
    expect(files.some(entry => entry.abs.includes('/lib/'))).toBe(false)
    expect(files.some(entry => entry.abs.includes('/vendor/'))).toBe(false)
    expect(files.some(entry => entry.abs.includes('/node_modules/'))).toBe(false)
  })
})
