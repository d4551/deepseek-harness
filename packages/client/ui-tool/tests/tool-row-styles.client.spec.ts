/**
 * The one-line contract of the ToolRow summary line as CSS text. jsdom has no
 * layout, so the rendering specs (chat-tool-row.spec.tsx) can pin which spans
 * exist but not whether a narrow row still fits on one line; these read the
 * declarations the layout depends on.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Declarations only: each sheet's prose names the properties it explains. */
function declarationText(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const ROW = '../src/client/tool/components/ToolRow.module.css'
// The summary text itself is ui-primitives' RowSummary, shared with every other
// flow row; only the row's own trailing slots stay here.
const SUMMARY = '../../ui-primitives/src/RowSummary.module.css'

function declarationsFrom(path: string, selector: string): string[] {
  // Anchored at a rule boundary: an unanchored match would silently read a
  // compound rule that merely contains the selector (`.root:hover .summarySuffix`)
  // if one ever lands above the base rule.
  const rule = new RegExp(`(?:^|\\})\\s*\\${selector}\\s*\\{([^{}]*)\\}`).exec(declarationText(path))
  if (rule === null) throw new Error(`${path} has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

const declarations = (selector: string): string[] => declarationsFrom(ROW, selector)

describe('ToolRow.module.css summary line', () => {
  it('keeps the summary suffix on one line and unshrunk', () => {
    // `flex: none` stops the box shrinking, not the text wrapping: without
    // `nowrap`, a row too narrow for title + separator + suffix wraps the `+n`
    // onto a second line — the exact case the slot exists to survive.
    expect(declarations('.summarySuffix')).toEqual(expect.arrayContaining([
      'flex: none',
      'white-space: nowrap',
    ]))
  })

  it('leaves the truncation to the summary text alone', () => {
    // The suffix must never ellipsize: a clipped count reads as a smaller
    // number rather than as missing information.
    expect(declarationsFrom(SUMMARY, '.summary')).toEqual(expect.arrayContaining([
      'overflow: hidden',
      'text-overflow: ellipsis',
      'white-space: nowrap',
    ]))
    expect(declarations('.summarySuffix')).not.toEqual(expect.arrayContaining(['text-overflow: ellipsis']))
  })

  it('sizes the summary texts from the secondary content tier', () => {
    // The Settings font-size preference must reach tool-call rows, not only
    // the narration body: summary, suffix, and file link read the secondary
    // tier (one step under the body), matching think text.
    const tier = [
      'font-size: var(--dsh-content-font-size-secondary, 13px)',
      'line-height: calc(24px + var(--dsh-content-font-delta, 0px))',
    ]
    expect(declarationsFrom(SUMMARY, '.summary')).toEqual(expect.arrayContaining(tier))
    for (const selector of ['.summarySuffix', '.fileLink']) {
      expect(declarations(selector)).toEqual(expect.arrayContaining(tier))
    }
  })
})
