import { describe, expect, it } from 'vitest'
import { findUiI18nViolations, isNonCopyDiagnostic } from './verify-client-ui-i18n.ts'

function messages(source: string): string[] {
  return findUiI18nViolations('packages/client/ui-example/src/client/View.tsx', source)
    .map(violation => violation.text)
}

describe('Client UI i18n source check', () => {
  it('rejects direct JSX copy and copy-bearing attributes', () => {
    expect(messages(`
      const View = ({ ready }: { ready: boolean }) => <section aria-label="Overview">
        <span>Hard-coded text</span>
        <input placeholder={ready ? 'Search now' : ` + "`Wait ${'${ready}'}`" + `} />
        <div runningSummary="Still working" />
      </section>
    `)).toEqual(['Overview', 'Hard-coded text', 'Search now', 'Wait', 'Still working'])
  })

  it('rejects copy kept in label data and copy helper returns', () => {
    expect(messages(`
      const TABS = [{ id: 'summary', label: 'Summary' }]
      function statusLabel(status: string): string {
        if (status === 'done') return 'Complete'
        return 'Still running'
      }
      function duration(): string { return 'Not recorded' }
      function mode(): string { return 'compact' }
      function displayFailureMessage(): string { return 'API key is invalid' }
      const emptySummary = 'Nothing to show'
      function Dialog({ closeLabel = 'Close dialog' }: { closeLabel?: string }) { return closeLabel }
    `)).toEqual([
      'Summary', 'Complete', 'Still running', 'Not recorded', 'API key is invalid',
      'Nothing to show', 'Close dialog',
    ])
  })

  it('accepts translated copy, dynamic values, structural attributes, and language tokens', () => {
    expect(messages(`
      const View = ({ t, value }: { t: (key: string) => string; value: string }) => (
        <section className="root" role="region" aria-label={t('overview')}>
          <span>{t('status.complete')}</span>
          <code>null</code>
          {value === 'pending' && <output>{value}</output>}
          <output>{value}</output>
        </section>
      )
    `)).toEqual([])
  })

  it('rejects copy painted straight onto the DOM, however it reaches the sink', () => {
    const probe = 'packages/client/ui-x/src/client/probe.ts'
    const caught = (source: string): number => findUiI18nViolations(probe, source).length
    // Every one of these paints reader-visible text. Tracing helper parameters
    // saw only the last of them.
    const painted: readonly [string, string][] = [
      ['textContent', "el.textContent = 'Loading plugins now'"],
      ['innerHTML', "el.innerHTML = 'Choose Preview data'"],
      ['placeholder', "input.placeholder = 'Search your sessions'"],
      ['insertAdjacentText', "el.insertAdjacentText('beforeend', 'Start the Preview')"],
      ['createTextNode', "el.append(document.createTextNode('Filesystem source'))"],
      ['append', "document.body.append('Failed to load plugins')"],
      ['aria-label attribute', "el.setAttribute('aria-label', 'Close the dialog')"],
      ['arrow sink', "const paint = (n, c) => { n.textContent = c }\npaint(el, 'Loading plugins now')"],
      ['method sink', "class V { paint(n, c) { n.textContent = c } }\nv.paint(el, 'Loading plugins now')"],
      ['first of two sink parameters', "function paint(a, b) { el.textContent = a; el.title = b }\npaint('Loading plugins now', x)"],
      ['copy between tags', 'el.innerHTML = `<h1>Choose Preview data</h1>`'],
      ['copy in a tag attribute', 'el.innerHTML = `<button title="Open the settings panel"></button>`'],
    ]
    for (const [name, source] of painted) expect(caught(source), name).toBeGreaterThan(0)
    // A machine value is not copy, and a template holding only structure is
    // not copy either.
    const structural: readonly [string, string][] = [
      ['data attribute', "el.setAttribute('data-test-id', 'plugin-card-open')"],
      ['form value', "input.value = 'plugin-card-open'"],
      ['tags only', 'el.innerHTML = `<form data-x aria-labelledby="source-title"><fieldset></fieldset></form>`'],
      ['interpolated copy', 'el.innerHTML = `<h1>${copy.heading}</h1>`'],
    ]
    for (const [name, source] of structural) expect(caught(source), name).toBe(0)
  })

  it('rejects copy that reaches the screen through component state', () => {
    const probe = 'packages/client/ui-x/src/client/probe.tsx'
    const caught = (source: string): number => findUiI18nViolations(probe, source).length
    // The setter is found through the pair's own destructuring, so no naming
    // convention is assumed, and the literal is found however deep in the call.
    expect(caught("const [e, setE] = useState(); setE('The operation failed')")).toBe(1)
    expect(caught("const [m, setM] = useState(); setM(c => new Map(c).set(id, r.message ?? 'The operation failed'))")).toBe(1)
    // State also holds keys, ids and status tags, which are not copy.
    expect(caught("const [e, setE] = useState(); setE('ArrowRight')")).toBe(0)
    expect(caught("const [e, setE] = useState(); setE('plugin-card-open')")).toBe(0)
    expect(caught("const box = { set(k, v) {} }; box.set(1, 'The operation failed')")).toBe(0)
  })

  it('reads a copy attribute however the template quotes it', () => {
    const probe = 'packages/client/ui-x/src/client/probe.ts'
    const caught = (source: string): number => findUiI18nViolations(probe, source).length
    // Templates are written in backticks, so single quotes are as idiomatic as
    // double ones inside them.
    for (const quote of ["'", '"']) {
      expect(caught(`el.innerHTML = \`<button aria-label=${quote}Close the dialog${quote}></button>\``), quote).toBe(1)
      expect(caught(`el.innerHTML = \`<i title=${quote}Open the settings panel${quote}></i>\``), quote).toBe(1)
    }
    expect(caught("el.innerHTML = `<form aria-labelledby='source-title'></form>`")).toBe(0)
  })

  it('exempts listed diagnostic text and nothing else in the same file', () => {
    const runner = 'packages/extensions/cordis-client-runner/src/client/runtime.ts'
    expect(isNonCopyDiagnostic(runner, 'your entry in slot "" crashed while React rendered it:')).toBe(true)
    expect(isNonCopyDiagnostic(runner, 'Save your changes before leaving')).toBe(false)
    expect(isNonCopyDiagnostic('packages/client/ui-x/src/client/probe.ts', 'Client')).toBe(false)
    // The listed text is exempt where it is listed, and rejected anywhere else.
    const message = "function renderFailureMessage() { return 'your entry in slot \"\" crashed while React rendered it:' }"
    expect(findUiI18nViolations(runner, message)).toEqual([])
    expect(findUiI18nViolations('packages/client/ui-x/src/client/probe.ts', message)).not.toEqual([])
  })

  it('does not inspect locale dictionary owners', () => {
    expect(findUiI18nViolations(
      'packages/client/ui-example/src/client/locales.ts',
      'export const en = { title: "Hard-coded by design" }',
    )).toEqual([])
  })
})
