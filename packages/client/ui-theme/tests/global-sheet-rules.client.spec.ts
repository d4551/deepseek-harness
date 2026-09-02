/**
 * Rules the global sheets own by name. `?inline` resolves to an empty string
 * under vitest, so the sheets are read as text, the way ui-primitives reads
 * DisclosureRow.module.css: these class names are the contract feature
 * packages write into their markup, exactly as component CSS writes a
 * `--dsw-*` token name, so a rename here is a rename in every writer.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Sheet text without its captions, so a rule a comment merely names is not read as declared. */
function sheet(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/styles/${name}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

describe('ui-theme global sheet rules', () => {
  it('declares the screen-reader-only box every colour-only signal is named by', () => {
    const css = sheet('visually-hidden.css')
    expect(css).toContain('.dsw-visually-hidden {')
    // The current clipping step. `clip: rect(0 0 0 0)` is the deprecated
    // spelling and apps/web targets es2022, which needs no fallback.
    expect(css).toContain('clip-path: inset(50%)')
    expect(css).not.toContain('clip: rect')
  })

  it('declares the Settings cell the General section composes its rows from', () => {
    const css = sheet('settings-cell.css')
    for (const rule of [
      '.dsw-settings-cell {',
      '.dsw-settings-cell-stack {',
      '.dsw-settings-cell-text {',
      '.dsw-settings-cell-title {',
      '.dsw-settings-cell-desc {',
      '.dsw-settings-selector {',
      '.dsw-settings-selector-chevron {',
    ]) expect(css).toContain(rule)
    // A pill that refuses the pick must not light up on hover, which is the
    // one behaviour the five contributing rows had spelled two different ways.
    expect(css).toContain('.dsw-settings-selector:hover:not(:disabled) {')
    expect(css).toContain('.dsw-settings-selector:disabled {')
  })
})
