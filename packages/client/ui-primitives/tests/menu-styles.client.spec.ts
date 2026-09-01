/**
 * Menu's inert-row styling as CSS text. The list marks an unavailable row with
 * `aria-disabled` so the arrows still reach it, which means the stylesheet has
 * to key its dimming and its hover suppression off that attribute rather than
 * the native `:disabled` state the row no longer carries. jsdom has no layout
 * and does not apply CSS-module rules, so the coupling between the rendered
 * attribute and the selectors that answer it is read here and asserted against
 * the rendered row in `atoms.client.spec.tsx`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/Menu.module.css', import.meta.url)), 'utf8')
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * The declarations of one exact selector rule.
 * @param selector - one selector as written in the stylesheet.
 * @returns its declarations, trimmed, in source order.
 */
function declarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]():*+^$\\|]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(declarationText)
  if (rule === null) throw new Error(`Menu.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('Menu.module.css inert rows', () => {
  it('dims the row the list marked unavailable', () => {
    expect(declarations(".item[aria-disabled='true']")).toEqual(expect.arrayContaining([
      'opacity: 0.4',
      'cursor: not-allowed',
    ]))
  })

  it('withholds both hover fills from it', () => {
    expect(declarations(".item:hover:not([aria-disabled='true'])")).toEqual([
      'background: var(--dsw-alias-interactive-bg-hover)',
    ])
    expect(declarations(".danger:hover:not([aria-disabled='true'])")).toEqual([
      'background: var(--dsw-alias-interactive-bg-hover-danger)',
    ])
  })

  it('keys nothing off the native disabled state the row no longer carries', () => {
    expect(declarationText).not.toMatch(/:disabled/)
  })
})
