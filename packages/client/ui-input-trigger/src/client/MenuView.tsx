/**
 * Trigger candidate menu: renders the InputTriggerService menu store into the
 * conversation.input.overlay anchor. Closed state renders null (the overlay
 * slot stays mounted); groups render in roster order under localized title
 * rows, pending groups as two skeleton rows, and a failed group as an alert
 * carrying the load failure's message plus its retry action; pointer picks
 * route back through the service (combobox pattern — focus never leaves the
 * textarea, so rows are mousedown-handled and the highlight is exposed via
 * aria-activedescendant on the listbox). A source publishing crumbs gets a
 * breadcrumb header pinned above the scrolling list.
 *
 * The scrolling candidate list is a native `<select size>` listbox opted into
 * `appearance: base-select` (MDN customizable select listboxes). Native option
 * elements carry the implicit option role, so oxlint prefer-tag-over-role does
 * not demand a dual widget, while Chrome 135+/145+ still renders icons,
 * descriptions, and the drill button inside each option.
 */
import { Fragment, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronRightOutline14, ReferenceIcon, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './MenuView.module.css'
import type { MenuViewInjected } from './slots.ts'
import { zh, type MenuKey } from './locales.ts'

/** Full menu props: injected face + the locale seat. */
export type MenuViewProps = MenuViewInjected & PropsLocale<'slash.menu'>

function isMenuKey(source: string): source is MenuKey {
  return Object.hasOwn(zh, source)
}

function sourceTitle(t: MenuViewProps['t'], source: string): string {
  return isMenuKey(source) ? t(source) : source
}

/** Design cap on the list height (figma SLASH 39:26572 MenuDropdown). */
const MAX_HEIGHT = 320

/** DOM id of one option row (the aria-activedescendant target). */
function optionId(source: string, index: number): string {
  return `dsh-slash-option-${source}-${index}`
}

/** Parse a native option value produced by {@link optionId}. */
function parseOptionId(value: string): { source: string; index: number } | undefined {
  const match = /^dsh-slash-option-(.+)-(\d+)$/.exec(value)
  const source = match?.[1]
  const indexText = match?.[2]
  if (source === undefined || indexText === undefined) return undefined
  return { source, index: Number(indexText) }
}

function readyCount(groups: ReadonlyArray<{ status: string; items: readonly unknown[] }>): number {
  return groups.reduce((count, group) => count + (group.status === 'ready' ? group.items.length : 0), 0)
}

function selectedValue(
  highlight: { source: string; index: number } | null,
  groups: ReadonlyArray<{ source: string; status: string; items: readonly unknown[] }>,
): string {
  if (highlight !== null) return optionId(highlight.source, highlight.index)
  for (const group of groups) {
    if (group.status === 'ready' && group.items.length > 0) return optionId(group.source, 0)
  }
  return ''
}

/**
 * Render the candidate menu overlay entry.
 * @param props - injected face (the menu store and the pick route); `t` rides the standard locale seat.
 * @returns the dropdown while open; null while closed.
 */
export function MenuView({ menu, headers, onPick, onCrumb, onHover, onRetry, onDismiss, t }: MenuViewProps) {
  const state = useSyncExternalStore(
    fn => menu.subscribe(fn),
    () => menu.getSnapshot(),
  )
  const crumbs = useSyncExternalStore(
    fn => headers.subscribe(fn),
    () => headers.getSnapshot(),
  )
  const listRef = useRef<HTMLDivElement>(null)
  // The list is bottom-anchored above the composer; clamp the design cap to
  // the space above it, re-measured on every store update (the anchor moves
  // when the composer grows).
  const maxHeight = useAnchoredMaxHeight(listRef, MAX_HEIGHT, state)
  const highlight = state.open ? state.highlight : null
  // Focus stays in the textarea (combobox pattern), so the browser never
  // scrolls the active option into view on keyboard moves — do it here.
  useEffect(() => {
    if (highlight === null) return
    document.getElementById(optionId(highlight.source, highlight.index))
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight])
  // Dismiss on pointer outside the menu AND outside the composer card
  // (clicking the textarea or bottom bar must not close the menu).
  useEffect(() => {
    if (!state.open) return
    const onPointerDown = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node)) return
      if (listRef.current?.contains(ev.target)) return
      const composerCard = listRef.current?.closest('[data-composer-card]')
      if (composerCard?.contains(ev.target)) return
      onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, onDismiss])
  if (!state.open) return null
  const optionCount = readyCount(state.groups)
  return (
    // The listbox role sits on the scrolling viewport, not this shell: a
    // breadcrumb header is not an option, and a listbox may not carry one.
    <div ref={listRef} className={css.menu} style={{ maxHeight }} data-trigger-menu="">
      {state.groups.map((group) => {
        const trail = crumbs.get(group.source)
        return trail === undefined ? null : (
          <nav key={group.source} className={css.crumbs} aria-label={t('crumbs.aria')}>
            {trail.map((crumb, index) => (
              <Fragment key={`${String(index)}-${crumb.value}`}>
                {index > 0 && <span className={css.crumbSeparator} aria-hidden><IconChevronRightOutline14 /></span>}
                <button
                  type="button"
                  className={clsx(css.crumb, crumb.current === true && css.crumbCurrent)}
                  aria-current={crumb.current === true ? 'location' : undefined}
                  disabled={crumb.current === true}
                  // mousedown, not click: the composer keeps focus, same as a row.
                  onMouseDown={(ev) => {
                    ev.preventDefault()
                    onCrumb(group.source, index)
                  }}
                >
                  {crumb.label}
                </button>
              </Fragment>
            ))}
          </nav>
        )
      })}
      {/* An empty listbox violates aria-required-children; with no ready
          options the pending and failed blocks below carry the open state alone. */}
      {optionCount > 0 && (
        <select
          className={css.viewport}
          data-trigger-listbox=""
          size={Math.max(2, optionCount)}
          tabIndex={-1}
          aria-label={t('suggestions.aria')}
          aria-activedescendant={highlight !== null ? optionId(highlight.source, highlight.index) : undefined}
          value={selectedValue(highlight, state.groups)}
          onMouseDown={(ev) => {
            // Keep composer focus (combobox). Drill buttons handle their own mousedown.
            if (ev.target instanceof HTMLButtonElement) return
            ev.preventDefault()
          }}
          onChange={(ev) => {
            const value = ev.currentTarget.value
            if (value === '') return
            const selected = parseOptionId(value)
            if (selected === undefined) throw new Error(`slash option ${value} is missing`)
            onHover(selected.source, selected.index)
          }}
        >
          {state.groups.map((group) => {
            if (group.status !== 'ready' || group.items.length === 0) return null
            const title = sourceTitle(t, group.source)
            const sectioned = group.items.some(item => item.section !== undefined)
            const wrapTitle = group.showGroupTitle !== false && !sectioned
            const options = group.items.map((item, index) => {
              const active = highlight !== null && highlight.source === group.source && highlight.index === index
              return (
                <option
                  key={optionId(group.source, index)}
                  id={optionId(group.source, index)}
                  value={optionId(group.source, index)}
                  className={clsx(css.item, active && css.active)}
                  data-icon={item.icon}
                  aria-selected={active}
                  onMouseDown={(ev) => {
                    if (ev.target instanceof HTMLButtonElement) return
                    ev.preventDefault()
                    onPick(group.source, index)
                  }}
                  onMouseMove={active ? undefined : () => { onHover(group.source, index) }}
                >
                  {item.icon !== undefined && (
                    <span className={css.itemIcon} aria-hidden>
                      <ReferenceIcon kind={item.icon} size={16} />
                    </span>
                  )}
                  <span className={css.itemName}>{item.name}</span>
                  {item.description !== undefined && <span className={css.itemDescription}>{item.description}</span>}
                  {item.drill === true && (
                    <span className={css.trailing}>
                      <span className={css.drillHintText} aria-hidden>{t('drill.hint')}</span>
                      <kbd className={css.drillHint} aria-hidden>{t('drill.key')}</kbd>
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t('drill.aria')}
                        className={css.drill}
                        onMouseDown={(ev) => {
                          ev.preventDefault()
                          ev.stopPropagation()
                          onPick(group.source, index, 'drill')
                        }}
                      >
                        <IconChevronRightOutline14 />
                      </button>
                    </span>
                  )}
                </option>
              )
            })
            if (sectioned) {
              const clusters: Array<{ label: string; nodes: ReactNode[] }> = []
              for (const [index, item] of group.items.entries()) {
                const label = item.section ?? title
                const node = options[index]
                if (node === undefined) throw new Error(`slash option ${String(index)} is missing`)
                const last = clusters.at(-1)
                if (last !== undefined && last.label === label) last.nodes.push(node)
                else clusters.push({ label, nodes: [node] })
              }
              return clusters.map(cluster => (
                <Fragment key={`${group.source}:${cluster.label}`}>
                  <div className={css.sectionTitle} role="presentation">{cluster.label}</div>
                  {cluster.nodes}
                </Fragment>
              ))
            }
            return (
              <Fragment key={group.source}>
                {wrapTitle
                  ? <div className={css.groupTitle} role="presentation" data-source={group.source}>{title}</div>
                  : null}
                {options}
              </Fragment>
            )
          })}
        </select>
      )}
      {/* Pending skeletons and failure alerts sit OUTSIDE the listbox: neither
          an output live region nor a role=alert is an allowed listbox child
          (axe aria-required-children). Both carry real text, so a screen
          reader hears the state a purely visual skeleton or an empty group
          body would leave silent. */}
      {state.groups.map(group => group.status === 'ready'
        ? null
        : (
          <Fragment key={group.source}>
            {group.showGroupTitle === false
              ? null
              : <div className={css.groupTitle} role="presentation" data-source={group.source}>{sourceTitle(t, group.source)}</div>}
            {group.status === 'failed'
              ? (
                <div className={css.error} role="alert" data-source={group.source}>
                  <span className={css.errorTitle}>{t('error.title', { source: sourceTitle(t, group.source) })}</span>
                  <span className={css.errorText}>{group.error}</span>
                  <button
                    type="button"
                    className={css.retry}
                    onMouseDown={(ev) => {
                      ev.preventDefault()
                      onRetry(group.source)
                    }}
                  >
                    {t('retry')}
                  </button>
                </div>
              )
              : (
                <output aria-label={t('loading')} data-source={group.source}>
                  <span className="dsw-visually-hidden">{t('loading')}</span>
                  <span className={css.skeletonRow}><span className={clsx(css.skeletonBar, css.skeletonBarShort)} /></span>
                  <span className={css.skeletonRow}><span className={clsx(css.skeletonBar, css.skeletonBarLong)} /></span>
                </output>
              )}
          </Fragment>
        ))}
    </div>
  )
}
