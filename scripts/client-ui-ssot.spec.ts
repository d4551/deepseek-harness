/**
 * UI SSOT scan: injected violations fail the collector; the live tree is a
 * second case, not the only one.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadUiSsotCorpus, scanUiSsot } from './client-ui-ssot.ts'
import { stripCssComments } from './ui-ssot-css.ts'

const THEME = {
  file: 'packages/client/ui-theme/src/styles/base.css',
  content: `
:root { --ds-transition-duration: 0.2s; --ds-transition-duration-fast: 0.1s; --ds-transition-duration-slow: 0.3s; }
body { --dsw-alias-label-primary: rgb(20, 20, 20); --dsw-alias-state-business-primary: rgb(0, 90, 200); }
@media (prefers-reduced-motion: reduce) {
  :root { --ds-transition-duration: 0.01ms; --ds-transition-duration-fast: 0.01ms; --ds-transition-duration-slow: 0.01ms; }
}
button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); }
`,
}

const FRAME = {
  file: 'packages/client/ui-layout/src/client/AppFrame.module.css',
  content: '.frame { display: grid; height: 100%; }\n',
}

describe('stripCssComments', () => {
  it('drops a caption so comments cannot hide a painted literal', () => {
    expect(stripCssComments('/* caption */ .a { color: var(--dsw-alias-label-primary); }')).not.toContain('caption')
  })
})

describe('injected SSOT violations', () => {
  it('fails a theme sheet that drops :focus-visible or reduced-motion token collapse', () => {
    const findings = scanUiSsot([{ file: THEME.file, content: ':root { --ds-transition-duration: 0.2s; }\n' }])
    expect(findings.some(f => f.kind === 'focus-visible')).toBe(true)
    expect(findings.some(f => f.kind === 'reduced-motion')).toBe(true)
  })

  it('fails an AppFrame that is not a grid shell', () => {
    const findings = scanUiSsot([
      THEME,
      { file: FRAME.file, content: '.frame { display: flex; height: 100%; }\n' },
    ])
    expect(findings.some(f => f.kind === 'shell-drift' && f.file === FRAME.file)).toBe(true)
  })

  it('fails a second page shell, float alignment, and forbidden stacks', () => {
    const findings = scanUiSsot([
      THEME,
      FRAME,
      {
        file: 'packages/client/ui-chat/src/Extra.module.css',
        content: 'body { display: grid; } .row { float: left; }\n',
      },
      { file: 'packages/client/ui-chat/src/Bad.tsx', content: "import 'daisyui'\n" },
      { file: 'apps/web/index.html', content: '<script src="/vendor/legacy.js"></script>\n' },
      { file: 'apps/web/src/page-helper.js', content: 'window.ready = true\n' },
    ])
    const kinds = new Set(findings.map(f => f.kind))
    expect(kinds.has('shell-drift')).toBe(true)
    expect(kinds.has('alignment')).toBe(true)
    expect(kinds.has('forbidden-stack')).toBe(true)
    expect(kinds.has('inline-script')).toBe(true)
    expect(kinds.has('one-off-script')).toBe(true)
  })

  it('flags painted color literals in component CSS', () => {
    const findings = scanUiSsot([
      THEME,
      FRAME,
      {
        file: 'packages/client/ui-chat/src/Painted.module.css',
        content: '.a { fill: rgb(1, 2, 3); } .b { stroke: oklch(0.7 0.1 250); }\n',
      },
    ])
    const painted = findings.filter(f => f.kind === 'token-bypass')
    expect(painted).toHaveLength(1)
    expect(painted[0]?.file).toBe('packages/client/ui-chat/src/Painted.module.css')
  })

  it('fails a raw stacking number in a module and accepts a --dsw-z-* token', () => {
    const findings = scanUiSsot([
      THEME,
      FRAME,
      {
        file: 'packages/client/ui-chat/src/Layered.module.css',
        content: '.a { position: absolute; z-index: 5; }\n.b { position: fixed; z-index: -1; }\n',
      },
      {
        file: 'packages/client/ui-chat/src/Tokened.module.css',
        content: '.c { position: fixed; z-index: var(--dsw-z-popover); }\n',
      },
      // The theme sheet declares the scale, so its own numbers are the SSOT.
      {
        file: 'packages/client/ui-theme/src/styles/z-scale.css',
        content: 'body { --dsw-z-popover: 100; }\n.probe { z-index: 100; }\n',
      },
    ]).filter(finding => finding.kind === 'z-index')
    expect(findings).toEqual([
      {
        file: 'packages/client/ui-chat/src/Layered.module.css',
        kind: 'z-index',
        detail: 'z-index: 5 is a raw stacking number; use a --dsw-z-* token',
      },
      {
        file: 'packages/client/ui-chat/src/Layered.module.css',
        kind: 'z-index',
        detail: 'z-index: -1 is a raw stacking number; use a --dsw-z-* token',
      },
    ])
  })

  it('fails an interactive control whose width and height are both under 24px', () => {
    // Fixture body lives in a data file: the geometry the detector must catch
    // is exactly what the repo's own UI rules forbid in authored sources.
    const findings = scanUiSsot([
      THEME,
      FRAME,
      {
        file: 'packages/client/ui-primitives/src/Tiny.module.css',
        content: readFileSync('scripts/fixtures/client-ui-ssot/tiny-button.css.txt', 'utf8'),
      },
    ])
    expect(findings.some(f => f.kind === 'hit-target')).toBe(true)
  })

  it('fails an infinite animation no reduced-motion rule actually stops', () => {
    const spinning = '.s { animation: spin 0.8s linear infinite; }'
    const guard = '@media (prefers-reduced-motion: reduce) { .s { animation: none; } }'
    // Every case names one animated selector, so the rule either answers it or
    // does not; `animates forever` is the per-selector finding.
    const scan = (content: string): number => scanUiSsot([{ file: 'Boot.module.css', content }])
      .filter(finding => finding.detail.includes('animates forever')).length
    // The theme collapses `--ds-transition-duration*`, but an `animation`
    // shorthand carries its own literal duration and never sees that.
    expect(scan(spinning)).toBe(1)
    expect(scan(`${spinning}${guard}`)).toBe(0)
    // A guard is not a sheet-wide credit. Each of these leaves the loop
    // running, and each passed before the rule read selectors and order.
    const cases: readonly [string, string][] = [
      ['hollow query', `${spinning}@media (prefers-reduced-motion: reduce) { .s { color: red; } }`],
      ['second animation unanswered', `${spinning}.t { animation: spin 2s infinite; }${guard}`],
      ['guard outside the query', `${spinning}@media (prefers-reduced-motion: reduce) { .s { color: red; } } .z { animation: none; }`],
      ['guard on another selector', `${spinning}@media (prefers-reduced-motion: reduce) { .other { animation: none; } }`],
      ['guard the rule overrides', `${guard}${spinning}`],
      ['longhand iteration count', '.s { animation-name: spin; animation-iteration-count: infinite; }'],
    ]
    for (const [name, content] of cases) expect(scan(content), name).toBe(1)
    // A `@keyframes` frame is not a selector, and `*` answers everything.
    expect(scan(`@keyframes spin { to { transform: rotate(1turn); } }${spinning}${guard}`)).toBe(0)
    expect(scan(`${spinning}@media (prefers-reduced-motion: reduce) { * { animation: none; } }`)).toBe(0)
    expect(scan(`.s, .t { animation: spin 1s infinite; }${guard}`)).toBe(1)
  })

  it('reads the query, the braces, and the selector before crediting a guard', () => {
    const frames = '@keyframes spin { to { transform: rotate(1turn); } }'
    const spinning = '.s { animation: spin 0.8s linear infinite; }'
    const scan = (content: string): number => scanUiSsot([{ file: 'Boot.module.css', content }])
      .filter(finding => finding.detail.includes('animates forever')).length
    // `no-preference` is the opposite query: stopping an animation there stops
    // it for the readers who did not ask for that.
    expect(scan(`${frames}${spinning}@media (prefers-reduced-motion: no-preference) { .s { animation: none; } }`)).toBe(1)
    expect(scan(`${frames}${spinning}@media (prefers-reduced-motion) { .s { animation: none; } }`)).toBe(0)
    // A brace inside a string is not a block, and miscounting it shifts every
    // rule after it into the wrong one.
    expect(scan(`${frames}.q::before { content: "{"; }${spinning}@media (prefers-reduced-motion: reduce) { .s { animation: none; } }`)).toBe(0)
    // Whitespace around a combinator is not selector identity.
    expect(scan(`${frames}.s > .t { animation: spin 1s infinite; }@media (prefers-reduced-motion: reduce) { .s>.t { animation: none; } }`)).toBe(0)
    // A duration too short to perceive is the documented idiom; a real one is
    // not a stop.
    expect(scan(`${frames}${spinning}@media (prefers-reduced-motion: reduce) { .s { animation-duration: 0.01ms; } }`)).toBe(0)
    expect(scan(`${frames}${spinning}@media (prefers-reduced-motion: reduce) { .s { animation-duration: 1s; } }`)).toBe(1)
  })

  it('does not credit a guard the browser may never reach, or miscount a value', () => {
    const frames = '@keyframes spin { to { transform: rotate(1turn); } }'
    const spinning = '.s { animation: spin 0.8s linear infinite; }'
    const guard = '@media (prefers-reduced-motion: reduce) { .s { animation: none; } }'
    const scan = (content: string): number => scanUiSsot([{ file: 'Boot.module.css', content }])
      .filter(finding => finding.detail.includes('animates forever')).length
    // `@supports not (...)` may never apply, so a guard inside it stops nothing.
    expect(scan(`${frames}${spinning}@supports not (display: grid) { ${guard} }`)).toBe(1)
    expect(scan(`${frames}${spinning}@supports (display: grid) { ${guard} }`)).toBe(0)
    // A comment opener inside a string is a value; treating it as a comment ate
    // everything up to the next real `*/`, guard included.
    expect(scan(`${frames}.q::before { content: "/*"; }/* note */${spinning}${guard}`)).toBe(0)
    // An unquoted `url()` may carry a brace that is not a block.
    expect(scan(`${frames}.q { background: url(data:text/plain,%7B{); }${spinning}${guard}`)).toBe(0)
  })

  it('fails a var() naming no declared token, fallback or not', () => {
    const findings = scanUiSsot([
      { file: 'theme.css', content: 'body { --dsw-alias-label-primary: rgb(0, 0, 0); }' },
      {
        file: 'Card.module.css',
        content: '.a { color: var(--dsw-alias-label-primary); }'
          + '.b { border-top: 1px solid var(--dsw-alias-separator-gone); }'
          + '.c { font-family: var(--dsw-font-absent, monospace); }',
      },
    ]).filter(finding => finding.kind === 'dangling-token')
    // The fallback in `.c` still counts: it hides a missing SSOT entry rather
    // than declaring one, and the next reference without a fallback breaks.
    expect(findings.map(finding => finding.detail).sort()).toEqual([
      'var(--dsw-alias-separator-gone) names no declared token; a fallback only hides the missing SSOT entry',
      'var(--dsw-font-absent) names no declared token; a fallback only hides the missing SSOT entry',
    ])
  })

  it('accepts a token declared in one file and used in another', () => {
    const findings = scanUiSsot([
      { file: 'theme.css', content: 'body { --dsw-alias-line-secondary: var(--dsw-alias-border-l2); --dsw-alias-border-l2: rgba(0,0,0,.1); }' },
      { file: 'Panel.module.css', content: '.p { border-top: 1px solid var(--dsw-alias-line-secondary); }' },
    ]).filter(finding => finding.kind === 'dangling-token')
    expect(findings).toEqual([])
  })

  it('fails literal colors in TSX style objects and SVG color attributes', () => {
    const findings = scanUiSsot([
      THEME,
      FRAME,
      {
        file: 'packages/client/ui-chat/src/Badge.tsx',
        content: "export const Badge = () => <span style={{ color: 'rgb(204, 0, 0)' }}>err</span>\n",
      },
      {
        file: 'packages/client/ui-chat/src/Icon.tsx',
        content: 'export const Icon = () => <svg><path fill="rgb(57, 100, 254)" d="M0 0" /></svg>\n',
      },
      {
        file: 'packages/client/ui-chat/src/Clean.tsx',
        content: 'export const Clean = () => <span className={css.ok}>ok</span>\n'
          + 'export const Stroke = () => <path stroke="currentColor" />\n'
          + 'export const Sized = () => <span style={{ left: props.left }}>x</span>\n',
      },
    ]).filter(finding => finding.kind === 'tsx-inline-color')
    expect(findings.map(finding => finding.file).sort()).toEqual([
      'packages/client/ui-chat/src/Badge.tsx',
      'packages/client/ui-chat/src/Icon.tsx',
    ])
  })

  it('fails a duplicated row shell across modules and accepts a unique one', () => {
    const shell = (selector: string): string =>
      `${selector} { display: grid; column-gap: 14px; padding: 12px 16px; }\n`
    const selectorAlt = '.unique'
    const glyphSlot = `${selectorAlt} { display: grid; flex: none; place-items: center; color: var(--dsw-alias-label-tertiary); }\n`
    const findings = scanUiSsot([
      THEME,
      FRAME,
      {
        file: 'packages/client/ui-chat/src/A.module.css',
        // .lead is a glyph-centering grid without inter-child spacing — shared
        // icon-slot styling, not a row shell, so it must not be flagged.
        content: shell('.shell') + glyphSlot + `${selectorAlt} { display: grid; column-gap: 16px; padding: 12px 16px; }\n`,
      },
      {
        file: 'packages/client/ui-tool/src/B.module.css',
        content: shell('.ioSection') + glyphSlot,
      },
    ]).filter(finding => finding.kind === 'duplicated-shell')
    expect(findings).toEqual([{
      file: 'packages/client/ui-tool/src/B.module.css',
      kind: 'duplicated-shell',
      detail: '`.ioSection` copies a grid shell first declared in packages/client/ui-chat/src/A.module.css',
    }])
  })

  it('fails a rule body copied into a second module and reads order as identity', () => {
    // Six declarations is the measured floor (DUPLICATE_RULE_DECLARATIONS):
    // this is the screen-reader-only box, the body that stood in twelve
    // modules at once before it moved to the theme sheet.
    const hidden = [
      'position: absolute', 'width: 1px', 'height: 1px',
      'overflow: hidden', 'clip-path: inset(50%)', 'white-space: nowrap',
    ]
    const rule = (selector: string, declarations: readonly string[]): string =>
      `${selector} { ${declarations.join('; ')}; }\n`
    const findings = scanUiSsot([
      THEME,
      FRAME,
      { file: 'packages/client/ui-chat/src/A.module.css', content: rule('.visuallyHidden', hidden) },
      // Reordered by a formatter is still the same rule, so the key sorts.
      { file: 'packages/client/ui-tool/src/B.module.css', content: rule('.status', [...hidden].reverse()) },
    ]).filter(finding => finding.kind === 'duplicated-rule')
    expect(findings).toEqual([{
      file: 'packages/client/ui-tool/src/B.module.css',
      kind: 'duplicated-rule',
      detail: '`.status` repeats a 6-declaration rule body first declared in packages/client/ui-chat/src/A.module.css',
    }])
  })

  it('accepts a body below the duplicate-rule floor and a second copy inside one module', () => {
    // Five declarations is the flex-ellipsis clamp: the corpus carries it at
    // three, four, and five declarations across unrelated components, so it is
    // convergence rather than a copied component and the floor lets it pass.
    const clamp = '{ flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n'
    const hidden = '{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }\n'
    const findings = scanUiSsot([
      THEME,
      FRAME,
      { file: 'packages/client/ui-primitives/src/Menu.module.css', content: `.itemLabel ${clamp}` },
      { file: 'packages/client/ui-subagent/src/Lineage.module.css', content: `.switcherTitle ${clamp}` },
      // One module owning two names for the same body is that module's own
      // business; the rule is about a body escaping its owner.
      { file: 'packages/client/ui-chat/src/A.module.css', content: `.status ${hidden}.altStatus ${hidden}` },
      // The theme sheet is where such a body belongs, so it is never an owner.
      { file: 'packages/client/ui-theme/src/styles/visually-hidden.css', content: `.dsw-visually-hidden ${hidden}` },
    ]).filter(finding => finding.kind === 'duplicated-rule')
    expect(findings).toEqual([])
  })

  it('fails selector blocks nested inside a style rule', () => {
    const findings = scanUiSsot([
      THEME,
      FRAME,
      { file: 'packages/client/ui-chat/src/Row.module.css', content: '.row { display: flex; .inner { margin: 0; } }\n' },
    ]).filter(finding => finding.kind === 'deep-nesting')
    expect(findings).toEqual([{
      file: 'packages/client/ui-chat/src/Row.module.css',
      kind: 'deep-nesting',
      detail: '`.row` nests selector blocks; flatten to one rule per selector',
    }])
  })

  it('fails vertical-align inside a flex or grid box and accepts it inline', () => {
    const findings = scanUiSsot([
      THEME,
      FRAME,
      {
        file: 'packages/client/ui-chat/src/Row.module.css',
        content: '.box { display: flex; vertical-align: middle; }\n.inline { vertical-align: baseline; }\n',
      },
    ]).filter(finding => finding.kind === 'alignment' && finding.detail.includes('vertical-align'))
    expect(findings).toEqual([{
      file: 'packages/client/ui-chat/src/Row.module.css',
      kind: 'alignment',
      detail: '`.box` aligns with vertical-align inside a flex/grid box; align with the box, not inline layout',
    }])
  })

  it('does not treat a tokenized, gridded, module-entry tree as dirty', () => {
    expect(scanUiSsot([
      THEME,
      FRAME,
      { file: 'packages/client/ui-chat/src/Row.module.css', content: '.row { color: var(--dsw-alias-label-primary); display: flex; }\n' },
      { file: 'apps/web/index.html', content: '<script type="module" src="/src/main.ts"></script>\n' },
    ])).toEqual([])
  })
})

describe('live UI SSOT corpus', () => {
  it('loads the theme, AppFrame, and feature CSS rather than passing on an empty glob', () => {
    const files = loadUiSsotCorpus()
    expect(files.length).toBeGreaterThan(40)
    expect(files.some(f => f.file.endsWith('ui-theme/src/styles/base.css'))).toBe(true)
    expect(files.some(f => f.file.endsWith('AppFrame.module.css'))).toBe(true)
  })

  it('reports no SSOT misses on the live client and web sources', () => {
    expect(scanUiSsot(loadUiSsotCorpus())).toEqual([])
  })

  it('writes every live stacking level through the --dsw-z-* scale', () => {
    const files = loadUiSsotCorpus()
    // The corpus has to actually carry stacked modules, or an empty scan reads
    // as a clean scale.
    const stacked = files.filter(f => f.file.endsWith('.module.css') && /z-index\s*:/.test(f.content))
    expect(stacked.length).toBeGreaterThan(30)
    expect(scanUiSsot(files).filter(finding => finding.kind === 'z-index')).toEqual([])
  })
})
