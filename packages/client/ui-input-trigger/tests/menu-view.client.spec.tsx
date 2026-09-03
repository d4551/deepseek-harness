// @vitest-environment jsdom
/**
 * MenuView rendering spec, props-direct: closed store
 * renders null, groups render in roster order under localized title rows
 * (unknown sources fall back to the raw name) with pending rows as skeleton
 * placeholders, pointer picks route (source, index) back without stealing
 * focus, the highlight is exposed through aria-activedescendant +
 * aria-selected, and the list height clamps to the space above the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import type {
  InputTriggerCrumb, MenuState, TriggerHit,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { MenuView } from '../src/client/MenuView.tsx'

const hit: TriggerHit = {
  trigger: '/',
  query: 'g',
  quoted: false,
  position: 'leading',
  span: { start: 0, end: 2, draftRev: 1 },
}

const CLOSED: MenuState = { open: false, hit: null, generation: 0, groups: [], highlight: null }

function openState(partial?: Partial<MenuState>): MenuState {
  return {
    open: true,
    hit,
    generation: 1,
    groups: [
      { source: 'command', status: 'ready', items: [{ name: 'goal', description: 'Set up a goal', icon: 'file' }, { name: 'plan' }] },
      { source: 'skill', status: 'pending', items: [] },
    ],
    highlight: { source: 'command', index: 0 },
    ...partial,
  }
}

// jsdom has no scrollIntoView; the view calls it on the highlighted option.
const scrollIntoView = vi.fn()
beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
  scrollIntoView.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// The framework-injected t seat, stubbed over the zh dictionaries (the
// default locale); the stub mirrors the LocaleRuntime key fallback, so an
// unknown source comes back verbatim (its raw name).
const t = makeTranslate(zh, commonZh)

function mount(state: MenuState, crumbs: ReadonlyMap<string, readonly InputTriggerCrumb[]> = new Map()) {
  const menu = createSnapshotStore<MenuState>(state)
  const headers = createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(crumbs)
  const onPick = vi.fn()
  const onCrumb = vi.fn()
  const onHover = vi.fn()
  const onRetry = vi.fn()
  const onDismiss = vi.fn()
  const view = render(
    <main>
      <MenuView
        menu={menu}
        headers={headers}
        onPick={onPick}
        onCrumb={onCrumb}
        onHover={onHover}
        onRetry={onRetry}
        onDismiss={onDismiss}
        t={t}
      />
    </main>,
  )
  return { menu, headers, onPick, onCrumb, onHover, onRetry, onDismiss, view }
}

/** The bounded menu shell: it owns the height clamp, the listbox scrolls inside it. */
function menuShell(): HTMLElement {
  const shell = document.querySelector('[data-trigger-menu]')
  if (!(shell instanceof HTMLElement)) throw new Error('menu shell is not rendered')
  return shell
}

/** The non-interactive group title rows (role=presentation), in document order. */
function titles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('div[role="presentation"][data-source]')]
    .map(el => el.textContent ?? '')
}

describe('MenuView', () => {
  it('renders null while closed and appears when the store opens', () => {
    const { menu, view } = mount(CLOSED)
    // The mount wrapper is <main>; "renders null" means it stays childless.
    expect(view.container.firstElementChild?.childElementCount).toBe(0)
    expect(view.container.querySelector('[data-trigger-menu]')).toBeNull()
    act(() => { menu.set(openState()) })
    expect(screen.queryByRole('listbox')).not.toBeNull()
    act(() => { menu.set(CLOSED) })
    expect(view.container.firstElementChild?.childElementCount).toBe(0)
  })

  it('renders ready groups as option rows and pending groups as two skeleton rows', () => {
    mount(openState())
    const options = screen.getAllByRole('option')
    expect(options.map(o => o.textContent)).toEqual(['goalSet up a goal', 'plan'])
    // The icon token renders as an SVG glyph, not text.
    expect(options[0]?.querySelector('svg')).not.toBeNull()
    expect(options[1]?.querySelector('svg')).toBeNull()
    // The loading state is announced by text, not by the skeleton bars alone.
    const status = screen.getByRole('status', { name: '正在加载…' })
    expect(status.textContent).toBe('正在加载…')
    expect(status.children).toHaveLength(3)
  })

  it('keeps an opted-out source title hidden while its candidates are pending', () => {
    mount(openState({
      groups: [{ source: 'reference', showGroupTitle: false, status: 'pending', items: [] }],
      highlight: null,
    }))
    expect(screen.queryByText('reference')).toBeNull()
    expect(screen.getByRole('status', { name: '正在加载…' })).toBeTruthy()
  })

  it('titles each group with the localized source name, raw name for unknown sources, none for empty ready groups', () => {
    const { view } = mount(openState({
      groups: [
        { source: 'command', status: 'ready', items: [{ name: 'goal' }] },
        { source: 'hollow', status: 'ready', items: [] },
        { source: 'mystery', status: 'ready', items: [{ name: 'x' }] },
        { source: 'skill', status: 'pending', items: [] },
      ],
    }))
    expect(titles(view.container)).toEqual(['指令', 'mystery', '技能'])
  })

  it('renders contiguous candidate sections once without changing option indexes', () => {
    const { onPick } = mount(openState({
      groups: [{
        source: 'reference',
        status: 'ready',
        items: [
          { name: 'Folder · src/', section: '文件与文件夹' },
          { name: 'File · README.md', section: '文件与文件夹' },
          { name: 'Session · Research', section: '对话' },
        ],
      }],
      highlight: { source: 'reference', index: 0 },
    }))
    expect(screen.queryByText('reference')).toBeNull()
    expect(screen.getAllByText('文件与文件夹')).toHaveLength(1)
    expect(screen.getAllByText('对话')).toHaveLength(1)
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual([
      'Folder · src/',
      'File · README.md',
      'Session · Research',
    ])
    fireEvent.mouseDown(options[2]!)
    expect(onPick).toHaveBeenCalledWith('reference', 2)
  })

  it('renders the drill chevron only on drillable rows and routes its own action', () => {
    const { onPick } = mount(openState({
      groups: [{
        source: 'reference',
        status: 'ready',
        items: [
          { name: 'Folder · src/', drill: true },
          { name: 'File · README.md' },
        ],
      }],
      highlight: { source: 'reference', index: 0 },
    }))
    const chevrons = screen.getAllByRole('button', { name: '进入目录' })
    expect(chevrons).toHaveLength(1)
    // The chevron drills; the row body still settles the pick untouched.
    fireEvent.mouseDown(chevrons[0]!)
    expect(onPick).toHaveBeenCalledWith('reference', 0, 'drill')
    fireEvent.mouseDown(screen.getAllByRole('option')[0]!)
    expect(onPick).toHaveBeenCalledWith('reference', 0)
  })

  it('exposes the highlight via aria-activedescendant and aria-selected', () => {
    mount(openState({ highlight: { source: 'command', index: 1 } }))
    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')
    expect(options[1]!.id).toBeTruthy()
    expect(listbox.getAttribute('aria-activedescendant')).toBe(options[1]!.id)
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')
    expect(options[0]!.getAttribute('aria-selected')).toBe('false')
  })

  it('omits aria-activedescendant without a highlight', () => {
    mount(openState({ highlight: null }))
    expect(screen.getByRole('listbox').getAttribute('aria-activedescendant')).toBeNull()
  })

  it('scrolls the highlighted option into view when the highlight moves', () => {
    const { menu } = mount(openState())
    scrollIntoView.mockClear()
    act(() => { menu.set(openState({ highlight: { source: 'command', index: 1 } })) })
    const options = screen.getAllByRole('option')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.instances.at(-1)).toBe(options[1])
  })

  it('caps the list height at the design maximum when the composer sits low enough', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ bottom: 800 } as DOMRect)
    mount(openState())
    expect(menuShell().style.maxHeight).toBe('320px')
  })

  it('clamps the list height to the space above the composer minus the safe margin', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ bottom: 200 } as DOMRect)
    mount(openState())
    expect(menuShell().style.maxHeight).toBe('188px')
  })

  it('re-fits the height when the window resizes', () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
    rect.mockReturnValue({ bottom: 800 } as DOMRect)
    mount(openState())
    expect(menuShell().style.maxHeight).toBe('320px')
    rect.mockReturnValue({ bottom: 100 } as DOMRect)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(menuShell().style.maxHeight).toBe('88px')
  })

  it('pointerdown outside the menu (no composer card ancestor) dismisses', () => {
    const { onDismiss } = mount(openState())
    fireEvent.pointerDown(document.body)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('pointerdown inside the list does not dismiss', () => {
    const { onDismiss } = mount(openState())
    fireEvent.pointerDown(screen.getAllByRole('option')[0]!)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('pointerdown inside the surrounding composer card does not dismiss; outside it does', () => {
    const menu = createSnapshotStore<MenuState>(openState())
    const onDismiss = vi.fn()
    render(
      <div data-composer-card="">
        <MenuView
          menu={menu}
          headers={createSnapshotStore<ReadonlyMap<string, readonly InputTriggerCrumb[]>>(new Map())}
          onPick={vi.fn()}
          onCrumb={vi.fn()}
          onHover={vi.fn()}
          onRetry={vi.fn()}
          onDismiss={onDismiss}
          t={t}
        />
        <button type="button" data-testid="composer-button" />
      </div>,
    )
    fireEvent.pointerDown(screen.getByTestId('composer-button'))
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('ignores a pointerdown whose target is not a DOM node', () => {
    const { onDismiss } = mount(openState())
    const ev = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(ev, 'target', { value: {} })
    document.dispatchEvent(ev)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('closing the menu removes the dismiss listener', () => {
    const { menu, onDismiss } = mount(openState())
    act(() => { menu.set(CLOSED) })
    fireEvent.pointerDown(document.body)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('mousedown on a row picks (source, index) and prevents the focus steal', () => {
    const { onPick } = mount(openState())
    const options = screen.getAllByRole('option')
    const notPrevented = fireEvent.mouseDown(options[1]!)
    // fireEvent returns false when preventDefault was called.
    expect(notPrevented).toBe(false)
    expect(onPick).toHaveBeenCalledWith('command', 1)
  })

  it('pointer motion over a row routes hover; the highlighted row stays silent', () => {
    const { onHover } = mount(openState())
    const options = screen.getAllByRole('option')
    fireEvent.mouseMove(options[1]!)
    expect(onHover).toHaveBeenCalledWith('command', 1)
    onHover.mockClear()
    // Index 0 already holds the highlight: no hover round-trip.
    fireEvent.mouseMove(options[0]!)
    expect(onHover).not.toHaveBeenCalled()
  })

  it('renders a source header as a breadcrumb above the list, current step last', () => {
    mount(openState(), new Map([['command', [
      { label: 'Workspace', value: 'root' },
      { label: 'src', value: 'src' },
      { label: 'module1', value: 'module1', current: true },
    ]]]))
    const nav = screen.getByRole('navigation', { name: '目录导航' })
    expect([...nav.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Workspace', 'src', 'module1'])
    // The listbox holds options alone; the header is its sibling, not a row.
    expect(screen.getByRole('listbox').contains(nav)).toBe(false)
  })

  it('mousedown on a crumb routes (source, index) without stealing focus; the current step is inert', () => {
    const { onCrumb } = mount(openState(), new Map([['command', [
      { label: 'Workspace', value: 'root' },
      { label: 'src', value: 'src', current: true },
    ]]]))
    const crumbs = screen.getByRole('navigation', { name: '目录导航' }).querySelectorAll('button')
    expect(fireEvent.mouseDown(crumbs[0]!)).toBe(false)
    expect(onCrumb).toHaveBeenCalledWith('command', 0)
    onCrumb.mockClear()
    expect(crumbs[1]!.disabled).toBe(true)
    fireEvent.mouseDown(crumbs[1]!)
    expect(onCrumb).not.toHaveBeenCalled()
  })

  it('renders no header for a source that published no crumbs', () => {
    mount(openState())
    expect(screen.queryByRole('navigation')).toBeNull()
  })
})

/**
 * The four states one source's group can be shown in. The failed state is the
 * one a catalog load reaches when its host request answers an application
 * error: the group keeps its seat, names itself, and carries the host's own
 * message plus the single affordance that repeats the request.
 */
describe('MenuView group states', () => {
  const failedState = (error = 'resume failed for session "s1": preset "meowbao" failed to mount'): MenuState =>
    openState({
      groups: [
        { source: 'command', status: 'failed', items: [], error },
        { source: 'skill', status: 'ready', items: [{ name: 'review' }] },
      ],
      highlight: { source: 'skill', index: 0 },
    })

  it('loading: the pending group announces itself and shows two skeleton rows', () => {
    mount(openState({ groups: [{ source: 'command', status: 'pending', items: [] }], highlight: null }))
    const status = screen.getByRole('status', { name: '正在加载…' })
    expect(status.textContent).toBe('正在加载…')
    expect(status.children).toHaveLength(3)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('empty: a settled group with no rows shows neither a title nor a listbox row', () => {
    const { view } = mount(openState({
      groups: [
        { source: 'command', status: 'ready', items: [] },
        { source: 'skill', status: 'ready', items: [{ name: 'review' }] },
      ],
      highlight: { source: 'skill', index: 0 },
    }))
    expect(titles(view.container)).toEqual(['技能'])
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['review'])
  })

  it('success: ready rows render as options under their group title', () => {
    const { view } = mount(openState())
    expect(titles(view.container)).toEqual(['指令', '技能'])
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['goalSet up a goal', 'plan'])
  })

  it('error: the failed group renders an alert with its title, the host message, and a retry action', () => {
    const { view } = mount(failedState())
    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('data-source')).toBe('command')
    expect(alert.textContent).toContain('指令加载失败')
    expect(alert.textContent).toContain('resume failed for session "s1": preset "meowbao" failed to mount')
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    // The failed group keeps its seat and its title. A listbox may hold only
    // options, so every non-ready block renders after it — the same place the
    // pending skeletons already take.
    expect(titles(view.container)).toEqual(['技能', '指令'])
    // A failure is not an option: the listbox holds the ready group alone.
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['review'])
    expect(screen.getByRole('listbox').contains(alert)).toBe(false)
  })

  it('error: a failed-only roster still renders the alert, and no listbox', () => {
    mount(openState({
      groups: [{ source: 'command', status: 'failed', items: [], error: 'offline' }],
      highlight: null,
    }))
    expect(screen.getByRole('alert').textContent).toContain('offline')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('error: an opted-out source title stays hidden while its group shows the failure', () => {
    const { view } = mount(openState({
      groups: [{ source: 'reference', showGroupTitle: false, status: 'failed', items: [], error: 'offline' }],
      highlight: null,
    }))
    expect(titles(view.container)).toEqual([])
    expect(screen.getByRole('alert').textContent).toContain('offline')
  })

  it('mousedown on retry routes the source without stealing composer focus', () => {
    const { onRetry } = mount(failedState())
    const notPrevented = fireEvent.mouseDown(screen.getByRole('button', { name: '重试' }))
    // fireEvent returns false when preventDefault was called.
    expect(notPrevented).toBe(false)
    expect(onRetry).toHaveBeenCalledWith('command')
  })

  it('a failure landing on the open menu replaces its skeleton with the alert', () => {
    const { menu } = mount(openState({
      groups: [{ source: 'command', status: 'pending', items: [] }],
      highlight: null,
    }))
    expect(screen.getByRole('status', { name: '正在加载…' })).toBeTruthy()
    act(() => {
      menu.set(openState({
        groups: [{ source: 'command', status: 'failed', items: [], error: 'offline' }],
        highlight: null,
      }))
    })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('offline')
  })
})

describe('slash menu accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations while the menu is open', async () => {
    const { view } = mount(openState())
    expect(accessibilityFailures(
      [await auditSurface('MenuView open', view.baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })

  it('renders no accessibility violations while a group shows its load failure', async () => {
    const { view } = mount(openState({
      groups: [
        { source: 'command', status: 'failed', items: [], error: 'offline' },
        { source: 'skill', status: 'ready', items: [{ name: 'review' }] },
      ],
      highlight: { source: 'skill', index: 0 },
    }))
    expect(accessibilityFailures(
      [await auditSurface('MenuView failed group', view.baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })
})
