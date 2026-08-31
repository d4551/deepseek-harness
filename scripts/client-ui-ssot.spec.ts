/**
 * UI SSOT scan: injected violations fail the collector; the live tree is a
 * second case, not the only one.
 */
import { describe, expect, it } from 'vitest'
import { loadUiSsotCorpus, scanUiSsot, stripCssComments } from './client-ui-ssot.ts'

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
      { file: 'apps/web/index.html', content: '<script>window.__x=1</script>\n' },
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

  it('fails an interactive control whose width and height are both under 24px', () => {
    const findings = scanUiSsot([
      THEME,
      FRAME,
      { file: 'packages/client/ui-primitives/src/Tiny.module.css', content: '.button { width: 8px; height: 8px; }\n' },
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
      { file: 'theme.css', content: 'body { --dsw-alias-label-primary: #000; }' },
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
})
