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
