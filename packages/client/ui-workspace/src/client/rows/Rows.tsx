/**
 * Workspace browser tree row components (figma Cell set 14:3080): pure presentational —
 * all data and callbacks arrive via props. Hover swaps (folder->chevron,
 * time->ellipsis, action buttons) are revealed by hover or by focus inside the
 * row, so the trailing verbs are reachable from the keyboard. Every row-menu
 * entry acts: workspace Rename/Delete, session Rename/Fork/Archive, and the one
 * bulk Archive row that replaces them while a range holds two or more rows. The
 * same list answers the trailing button, a right-click anywhere on the row, and
 * the keyboard's own menu request, and the session and workspace hover cards are
 * suppressed while a menu is open.
 */
import { useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import clsx from 'clsx'
import {
  HoverCard, IconArchiveOutline20, IconBranchOutline16, IconEditOutline16,
  IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16, IconPlusOutline16,
  IconTrashOutline16, IconTriangleRightFill14, Menu, relativeTime, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuItem, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import { additiveModifier, secondaryPress } from '../pointer-platform.ts'
import type { FocusTarget } from '../row-focus.ts'
import type { RowKey } from '../selection.ts'
import type { GroupNode, SearchResultNode, SessionNode } from '../tree.ts'
import css from './Rows.module.css'

/** The standard locale seat, prop-passed from the browser root. */
type RowTranslate = WorkspaceBrowserProps['t']

/** Row display title: blank rows show the localized New Session label. */
function displayTitle(node: SessionNode, t: RowTranslate): string {
  return node.blank ? t('session.new') : node.title
}

/** Localized compact relative time ("刚刚"/"5分钟" in zh, "now"/"5min" in en). */
function timeLabel(updatedAt: number, now: number, t: RowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/** Hover-card variant: distances wrap in the ago template; the now bucket stays bare (no "now ago"). */
function hoverTimeLabel(updatedAt: number, now: number, t: RowTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n }) })
}

/**
 * Absolute creation time through the dictionary's date template (the message
 * clock pattern): `toLocaleString` would follow the browser language, not the
 * app locale, and produce mixed-language text after a switch.
 */
function createdLabel(createdAt: number, t: RowTranslate): string {
  const d = new Date(createdAt)
  const pad2 = (v: number): string => String(v).padStart(2, '0')
  const date = t('date.ymd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return t('hover.created', { time: `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` })
}

/** Hover-card body: workspace title, display directory path, absolute creation time. */
function WorkspaceHoverContent({ label, cwd, createdAt, t }: {
  label: string
  cwd: string | undefined
  createdAt: number
  t: RowTranslate
}) {
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{label}</div>
      <div className={css.hoverPath}>{cwd}</div>
      <div className={css.hoverTime}>{createdLabel(createdAt, t)}</div>
    </div>
  )
}

/**
 * Row drag wiring supplied by the tree owner. `drop` reports the half of the
 * row where the pointer released so the owner can resolve an insert anchor.
 */
export interface RowDragProps {
  /** Start dragging this row. */
  start: () => void
  /** A compatible row drag is in flight. */
  active: boolean
  /** Current marker on this row: insert line above, below, or none. */
  marker: 'before' | 'after' | null
  /** Report the hovered half while a compatible drag passes over this row. */
  hover: (half: 'before' | 'after') => void
  drop: (half: 'before' | 'after') => void
  end: () => void
}

/** Drag lifecycle owned by a workspace row; its enclosing group owns hit testing. */
interface WorkspaceRowDragProps {
  start: () => void
  end: () => void
}

/** Pointer-position half of a row (insert line above or below). */
function rowHalf(e: { clientY: number; currentTarget: HTMLElement }): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** One row's menu state; the two row kinds differ only in the entries they supply. */
interface RowMenu {
  /** The list is showing; the row pins its hover affordances meanwhile. */
  open: boolean
  /** `Menu` placement override, spread in; empty while the trailing button anchors the list. */
  anchorProps: { getAnchorRect?: () => DOMRect }
  /** The list was asked for from the keyboard, so it owes its first row the focus. */
  autoFocus: boolean
  /** Row `onContextMenu`: replace the platform menu with this row's list. */
  openFrom: (event: ReactMouseEvent) => void
  /** Trailing `...` button click, from the pointer or from Enter/Space on it. */
  toggle: (event: ReactMouseEvent) => void
  /** A selection, Escape, or an outside press closed the list. */
  close: () => void
}

/** Where a row menu was asked to open, and whether the asking held the focus. */
interface MenuOrigin {
  /** The rect `Menu` places the list against, or nothing to let `Menu` measure its own wrapper. */
  rect: DOMRect | null
  /** The list must take the focus, because the gesture that asked for it had it. */
  seated: boolean
}

/**
 * Row menu state shared by both row kinds. The trailing `...` button, a
 * right-click anywhere on the row, and the keyboard's own menu request open the
 * same list. Only a secondary press carries a cursor worth honouring, so its
 * list opens under that cursor instead of at a button the row reveals on hover;
 * every other `contextmenu` — Shift+F10, the ContextMenu key, a touch
 * long-press — opens against the row. The list takes the focus whenever the
 * keyboard asked for it — the row held the focus when the request arrived, or
 * the button's click carried no pointer detail — and never when a press asked,
 * whose operator is not inside the list.
 * @returns the open flag, the placement override, the focus claim, and the
 * three gestures.
 */
function useRowMenu(): RowMenu {
  const [origin, setOrigin] = useState<MenuOrigin | null>(null)
  const [open, setOpen] = useState(false)
  const anchorProps = useMemo(() => {
    const rect = origin?.rect
    return rect == null ? {} : { getAnchorRect: () => rect }
  }, [origin])
  return {
    open,
    anchorProps,
    autoFocus: open && origin?.seated === true,
    openFrom: (event) => {
      event.preventDefault()
      event.stopPropagation()
      const row = event.currentTarget
      const pointed = secondaryPress(event)
      setOrigin({
        rect: pointed ? new DOMRect(event.clientX, event.clientY, 0, 0) : row.getBoundingClientRect(),
        // Every `contextmenu` no press asked for came from the keyboard,
        // wherever inside the row the focus sat — the row itself or its
        // trailing button. A press never claims the focus.
        seated: !pointed && row.contains(document.activeElement),
      })
      setOpen(true)
    },
    toggle: (event) => {
      event.stopPropagation()
      // The button anchors its own list, so the placement override stays empty.
      // Enter and Space on a focused button synthesize a click that carries no
      // pointer detail; that click's operator is in the keyboard, so the list
      // owes them its first row exactly as a keyboard contextmenu request does.
      setOrigin({ rect: null, seated: event.detail === 0 })
      setOpen(showing => !showing)
    },
    close: () => { setOpen(false) },
  }
}

/**
 * One row's slice of its list's ordered account: what the row shows, what a
 * gesture on it means, and whether it currently holds the list's tab stop. Both
 * row kinds carry the same contract: the list owns the set, the order, and the
 * focus, and the row reports gestures and renders only what it is told. The
 * pointer and the keyboard edit one selection through the same three verbs.
 */
export interface RowMultiSelection {
  /** This row is in the selection (distinct fill and `aria-selected`). */
  active: boolean
  /** Rows selected across the list; two or more widen every row menu in it. */
  count: number
  /**
   * Sessions the bulk archive reaches. A selected Workspace row answers for
   * its members, so this is not the row count.
   */
  archivableCount: number
  /** Shift-click or Shift+Space: select every rendered row between the anchor and this one. */
  extend: () => void
  /** Cmd-click on Apple platforms, Ctrl-click elsewhere, or Space: add or remove this row. */
  toggle: () => void
  /** The same modifier with A: take every row the list's range can reach. */
  selectAll: () => void
  /** Plain click or Enter: this row becomes the anchor and any previous selection drops. */
  anchor: () => void
  /** Archive every session the selection reaches. */
  archiveSelected: () => void
}

/**
 * One row's seat in its list's tab order. Every rendered row carries one,
 * including the rows a range cannot select: the arrows walk the whole tree, and
 * a row a range skips still has verbs of its own to reach.
 */
export interface RowSeat {
  /**
   * The row's key in the account, published to the DOM so the list can hand it
   * the focus without the moving row having to reach its siblings.
   */
  rowKey: RowKey
  /** This row holds the list's single tab stop (the tree pattern's roving tabindex). */
  seated: boolean
  /** The row's depth in the tree, reported as `aria-level`. */
  level: number
  /**
   * Move the tab stop and the focus to another row of the account; `extend`
   * takes the range along, the keyboard's Shift-click, and does nothing on a
   * row no range can reach.
   */
  move: (target: FocusTarget, extend: boolean) => void
  /**
   * Move the tab stop and the focus to the next row whose label starts with
   * what has been typed — the tree pattern's type-ahead.
   */
  typeAhead: (character: string) => void
}

/**
 * Route a row keystroke through the list's tab stop and its selection. The
 * arrows and Home/End move the focus, Shift takes the range along with the
 * move, Space edits the selection where a click's modifier would, Enter does
 * what a plain click does, the additive modifier with A takes the whole range,
 * and a printable character searches the list by row label. A row outside every
 * range still walks, still searches, and still activates; only the selection
 * keys go unanswered there. Every other key
 * keeps its browser meaning. The caller has already established that the
 * keystroke is the row's own.
 * @param seat - the row's place in the tab order.
 * @param selection - the row's selection slice, absent on unselectable rows.
 * @param activate - what a plain click on this row does.
 * @param event - the keystroke being routed.
 */
export function rowKeyDown(
  seat: RowSeat,
  selection: RowMultiSelection | undefined,
  activate: () => void,
  event: ReactKeyboardEvent,
): void {
  // Select-all is answered before the switch, because the type-ahead below
  // refuses every key carrying a command modifier and would otherwise be the
  // last word on this one. A row no range reaches has no account to take.
  if (additiveModifier(event) && event.key.toLowerCase() === 'a') {
    if (selection === undefined) return
    selection.selectAll()
    event.preventDefault()
    return
  }
  switch (event.key) {
    case 'ArrowDown': seat.move('next', event.shiftKey); break
    case 'ArrowUp': seat.move('previous', event.shiftKey); break
    case 'Home': seat.move('first', event.shiftKey); break
    case 'End': seat.move('last', event.shiftKey); break
    case ' ':
      // A row no range reaches has nothing to toggle, so Space keeps its own
      // meaning there rather than becoming a key that swallows the page scroll.
      if (selection === undefined) return
      if (event.shiftKey) selection.extend()
      else selection.toggle()
      break
    case 'Enter':
      selection?.anchor()
      activate()
      break
    default:
      // A key the browser names with one character, and no command modifier
      // on it, searches the list by label; every other key keeps its own
      // meaning, so the guard below is the only place that takes one away.
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
      seat.typeAhead(event.key)
      break
  }
  event.preventDefault()
}

/**
 * Route a row click through the multi-selection. Shift extends the range and
 * the platform's additive modifier adds or removes one row; either replaces the
 * row's own activation.
 * A plain click re-anchors the range and lets the row act as it always did. A
 * click that arrives while this row's menu is up is swallowed whole, whatever
 * opened it: WebKit dispatches a `click` for an Apple Ctrl+click as well as
 * the `contextmenu` that press asked for, and a click reaching the row from
 * under any open list is the press that dismisses the list. Reading the row's
 * own menu rather than the platform keeps that true on a host whose
 * `navigator.platform` says otherwise.
 * @param selection - the row's selection wiring, absent on unselectable rows.
 * @param menuOpen - whether this row's menu is showing.
 * @param event - the click being routed.
 * @returns whether the click was answered before the row's own activation.
 */
function selectionTookClick(
  selection: RowMultiSelection | undefined,
  menuOpen: boolean,
  event: ReactMouseEvent,
): boolean {
  if (menuOpen) return true
  if (selection === undefined) return false
  if (event.shiftKey) { selection.extend(); return true }
  if (additiveModifier(event)) { selection.toggle(); return true }
  selection.anchor()
  return false
}

/**
 * Whether a row should answer this keystroke at all. Two things take it away.
 * A control inside the row answers its own keys: the trailing `...` button
 * handles Enter and Space, and the row menu it opens is a React child of the
 * row, so its portaled list bubbles back through the React tree — without the
 * target test the arrows would walk the menu and the list underneath it at
 * once. An open row menu then owns the keyboard outright while it is up, since
 * its list's own arrow handler sees nothing until the focus is inside it, and
 * the row would otherwise walk a tree beneath a list still anchored where it
 * opened.
 * @param event - the keystroke the row received.
 * @param menuOpen - whether this row's menu is showing.
 * @returns whether the row owns the keystroke.
 */
function rowOwnsKey(event: ReactKeyboardEvent, menuOpen: boolean): boolean {
  return !menuOpen && event.target === event.currentTarget
}

/**
 * Answer a row's menu request, from the pointer or from the keyboard. A request
 * from outside the current range narrows the selection to this row first, the
 * platform rule.
 * @param menu - the row's menu state.
 * @param selection - the row's account slice, absent on unselectable rows.
 * @param event - the contextmenu event being answered.
 */
function openRowMenu(
  menu: RowMenu,
  selection: RowMultiSelection | undefined,
  event: ReactMouseEvent,
): void {
  if (selection !== undefined && !selection.active) selection.anchor()
  menu.openFrom(event)
}

/** A selection of two or more rows, whose bulk row replaces the per-row verbs. */
function widenedSelection(selection: RowMultiSelection | undefined): RowMultiSelection | undefined {
  return selection !== undefined && selection.active && selection.count > 1 ? selection : undefined
}

/**
 * The one action a multi-row selection defines. Rename, Fork, and Delete all
 * address a single row, so the widened list carries this row alone; a range of
 * empty projects reaches no Session and leaves it inert rather than absent.
 * @param selection - the widened selection.
 * @param t - the browser root's locale seat.
 * @returns the sole menu row.
 */
function bulkArchiveItems(selection: RowMultiSelection, t: RowTranslate): MenuItem[] {
  return [{
    id: 'archive-selected',
    label: t(
      selection.archivableCount === 1 ? 'menu.archiveSelected.one' : 'menu.archiveSelected.other',
      { n: selection.archivableCount },
    ),
    // 20-native glyph in the menu's 16px icon slot (Menu.module.css .itemIcon).
    icon: <IconArchiveOutline20 size={16} />,
    disabled: selection.archivableCount === 0,
  }]
}

/**
 * Project (workspace) header row: folder + title;
 * hover reveals the chevron and create button, and dwelling on a real
 * Workspace shows its hover card (the ungrouped bucket has none).
 * `containsCurrent` arrives on the node (derivation fact, no renderer scan).
 * @param props.group - derived group node.
 * @param props.onToggle - expand/collapse the group.
 * @param props.onCreate - start a frontend Session inside this Workspace.
 * @param props.seat - the row's place in the list's tab order.
 * @param props.selection - multi-selection wiring; absent on the ungrouped bucket.
 * @param props.drag - optional workspace-row drag wiring.
 * @param props.home - host account home for POSIX hover-path abbreviation.
 * @param props.t - the browser root's locale seat.
 * @returns the row element.
 */
export function ProjectRowItem({ group, onToggle, onCreate, actions, seat, selection, drag, home, t }: {
  group: GroupNode
  onToggle: () => void
  onCreate: () => void
  /** Real-Workspace actions; absent for the ungrouped bucket (no menu shown). */
  actions?: { rename: () => void; delete: () => void } | undefined
  /** The row's place in the list's tab order; every rendered row has one. */
  seat: RowSeat
  /**
   * Multi-selection wiring. Absent on the ungrouped bucket, which has no
   * backing Workspace and therefore no row verbs to apply to a range.
   */
  selection?: RowMultiSelection | undefined
  /** Present only for real Workspace rows in the grouped view. */
  drag?: WorkspaceRowDragProps | undefined
  /** Host account home; POSIX home-rooted hover paths display as `~`. */
  home?: string | undefined
  t: RowTranslate
}) {
  const row = group
  // The ungrouped bucket has no workspace title: its label is dictionary copy.
  const label = row.workspaceId === undefined ? t('group.ungrouped') : row.label
  const active = group.expanded && group.containsCurrent
  const menu = useRowMenu()
  const menuOpen = menu.open
  const inSelection = selection?.active === true
  const bulk = widenedSelection(selection)
  const workspaceMenuItems = bulk === undefined
    ? [
      { id: 'rename', label: t('rename'), icon: <IconEditOutline16 /> },
      { id: 'delete', label: t('delete.workspace'), icon: <IconTrashOutline16 />, danger: true },
    ]
    : bulkArchiveItems(bulk, t)
  const ownRow = (
    <div
      className={clsx(css.projectRow, menuOpen && css.menuOpen, inSelection && css.multiSelected)}
      role="treeitem"
      aria-expanded={row.expanded}
      aria-level={seat.level}
      // Only a row a range can reach reports selection state; on the Ungrouped
      // bucket `aria-selected="false"` would promise a selection it never takes.
      {...selection === undefined ? {} : { 'aria-selected': selection.active }}
      tabIndex={seat.seated ? 0 : -1}
      data-row-key={seat.rowKey}
      data-row-label={label}
      onClick={(e) => {
        // A modified click edits the range instead of folding the group.
        if (selectionTookClick(selection, menuOpen, e)) return
        onToggle()
      }}
      onKeyDown={(e) => {
        if (!rowOwnsKey(e, menuOpen)) return
        // The horizontal arrows work the disclosure the tree pattern gives a
        // parent node: open a folded group, fold an open one, and step into
        // the first child of a group already open.
        if (e.key === 'ArrowRight') {
          if (row.expanded) seat.move('next', false)
          else onToggle()
          e.preventDefault()
          return
        }
        if (e.key === 'ArrowLeft') {
          if (row.expanded) onToggle()
          e.preventDefault()
          return
        }
        rowKeyDown(seat, selection, onToggle, e)
      }}
      // The ungrouped bucket has no Workspace verbs, so it keeps the platform menu.
      onContextMenu={actions === undefined
        ? undefined
        : (e) => { openRowMenu(menu, selection, e) }}
      draggable={drag !== undefined}
      onDragStart={drag === undefined
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', row.key)
          drag.start()
        }}
      onDragEnd={drag?.end}
    >
      <span className={clsx(css.slot, css.folder, active && css.folderActive)}>
        {row.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      </span>
      <span className={clsx(css.slot, css.chevron)}>
        <IconTriangleRightFill14 className={clsx(css.arrow, row.expanded && css.arrowOpen)} />
      </span>
      <span className={css.projectText}>
        <span className={css.title}>{label}</span>
      </span>
      <span className={css.rowActions}>
        {actions !== undefined && (
          <Menu
            open={menuOpen}
            onClose={menu.close}
            items={workspaceMenuItems}
            onSelect={(id) => {
              menu.close()
              // The widened list carries the bulk row alone, so it needs no id test.
              if (bulk !== undefined) { bulk.archiveSelected(); return }
              // Unknown ids leave before the dispatch: a future menu row must
              // not inherit the destructive branch as an else fallback.
              /* v8 ignore next -- Menu can emit only the rename and delete rows supplied above. */
              if (id !== 'rename' && id !== 'delete') return
              if (id === 'rename') actions.rename()
              else actions.delete()
            }}
            portal
            closeOnPointerLeave
            autoFocus={menu.autoFocus}
            ariaLabel={t('actions.workspace.aria', { name: label })}
            {...menu.anchorProps}
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('actions.workspace.aria', { name: label })}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={menu.toggle}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        )}
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('actions.newSession.aria', { name: label })}
          onClick={(e) => { e.stopPropagation(); onCreate() }}
        >
          <IconPlusOutline16 />
        </button>
      </span>
    </div>
  )
  // The ungrouped bucket has no backing Workspace: no card to show.
  if (row.createdAt === undefined) return ownRow
  return (
    <HoverCard
      // The row is a treeitem its tree owns; a generic wrapper between the two
      // would break that ownership.
      presentational
      anchor={ownRow}
      content={<WorkspaceHoverContent
        label={row.label}
        cwd={row.cwd === undefined ? undefined : abbreviateHomePath(row.cwd, home)}
        createdAt={row.createdAt}
        t={t}
      />}
      disabled={menuOpen}
      copyText={row.cwd}
      copyLabel={t('copy')}
      copiedLabel={t('hover.copied')}
    />
  )
}

/* v8 ignore next 3 -- closed-union backstop; only reached if the status is forged */
function assertNever(value: never): never {
  throw new Error(`unknown pending interaction: ${String(value)}`)
}

interface SessionStatus {
  state: StateDotState
  label: string
}

/**
 * Session status presentation; pending interaction is primary and live activity
 * outranks completion reminders.
 */
function sessionStatuses(
  node: Pick<SessionNode, 'pendingInteraction' | 'running' | 'runningSubagentCount' | 'completed'>,
  t: RowTranslate,
): readonly [SessionStatus, ...SessionStatus[]] {
  const subagents: SessionStatus | undefined = node.runningSubagentCount === 0
    ? undefined
    : {
      state: 'ongoing',
      label: t(
        node.runningSubagentCount === 1
          ? 'status.subagentsRunning.one'
          : 'status.subagentsRunning.other',
        { n: node.runningSubagentCount },
      ),
    }
  let pending: SessionStatus | undefined
  switch (node.pendingInteraction) {
    case 'approval':
      pending = { state: 'warning', label: t('status.waitingApproval') }
      break
    case 'plan-review':
      pending = { state: 'warning', label: t('status.planReview') }
      break
    case 'question':
      pending = { state: 'warning', label: t('status.waitingAnswer') }
      break
    case undefined: break
    /* v8 ignore next -- closed PendingInteractionStatus union */
    default: return assertNever(node.pendingInteraction)
  }
  if (pending !== undefined) return subagents === undefined ? [pending] : [pending, subagents]
  if (node.running) {
    const primary: SessionStatus = { state: 'ongoing', label: t('status.running') }
    return subagents === undefined ? [primary] : [primary, subagents]
  }
  if (subagents !== undefined) return [subagents]
  if (node.completed) return [{ state: 'done', label: t('status.completed') }]
  return [{ state: 'done', label: t('status.idle') }]
}

/** Primary status dot plus every status's screen-reader label, shared by the search and session rows. */
function SessionStatusDots({ statuses }: { statuses: readonly [SessionStatus, ...SessionStatus[]] }) {
  return (
    <>
      <StateDot state={statuses[0].state} />
      {statuses.map(status => (
        <span className={css.visuallyHidden} key={status.label}>{status.label}</span>
      ))}
    </>
  )
}

/** Hover-card body: full title, relative time, and every relevant live status. */
function SessionHoverContent({ node, now, t }: { node: SessionNode; now: number; t: RowTranslate }) {
  const statuses = sessionStatuses(node, t)
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{displayTitle(node, t)}</div>
      {/* Same placeholder rule as the row's trailing cell: no timestamp
          before the first prompt. */}
      {!node.blank && <div className={css.hoverTime}>{hoverTimeLabel(node.updatedAt, now, t)}</div>}
      {statuses.map(status => (
        <div className={css.hoverStatus} key={status.label}>
          <StateDot state={status.state} />
          <span>{status.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * One flat search result: title, Workspace context, and optional content
 * excerpt. Search navigation opens the session only; it does not address an
 * event inside the conversation. The results are a tree of one level, so they
 * hold one tab stop between them and the arrows move it, exactly as the two
 * session lists do; no range reaches them, so Shift carries nothing and no row
 * reports selection state.
 * @param props.result - merged local/content search row.
 * @param props.currentId - selected session id.
 * @param props.onOpen - open the selected session.
 * @param props.seat - the row's place in the result list's tab order.
 * @param props.t - Workspace-browser translation seat.
 * @returns the result button.
 */
export function SearchResultItem({ result, currentId, onOpen, seat, t }: {
  result: SearchResultNode
  currentId: string | undefined
  onOpen: (id: SearchResultNode['id']) => void
  seat: RowSeat
  t: RowTranslate
}) {
  const selected = result.id === currentId
  const statuses = sessionStatuses(result, t)
  const primaryStatus = statuses[0]
  return (
    <button
      type="button"
      className={clsx(css.searchResultRow, selected && css.selected)}
      role="treeitem"
      aria-level={seat.level}
      // The open Session is the list's current row. No range reaches a result,
      // so the row promises no selection state either — the same rule the
      // session rows keep for the rows a range cannot select.
      {...selected ? { 'aria-current': true } : {}}
      tabIndex={seat.seated ? 0 : -1}
      data-row-key={seat.rowKey}
      data-row-label={result.title}
      onClick={() => { onOpen(result.id) }}
      // A result row holds no control of its own, so every keystroke reaching
      // it is the row's own; the project and session rows guard for theirs.
      onKeyDown={(e) => { rowKeyDown(seat, undefined, () => { onOpen(result.id) }, e) }}
    >
      <span className={css.searchResultHeading}>
        <span className={css.slot}>
          {(primaryStatus.state !== 'done' || result.completed) && (
            <SessionStatusDots statuses={statuses} />
          )}
        </span>
        <span className={css.searchResultTitle}>{result.title}</span>
      </span>
      <span className={css.searchResultMeta}>
        <span className={css.searchResultWorkspace}>{result.workspace || t('group.ungrouped')}</span>
        {result.snippet !== undefined && (
          <span className={css.searchResultSnippet}>{result.snippet}</span>
        )}
      </span>
    </button>
  )
}

/**
 * One top-level 34px session row: status dot (pending user interaction outranks
 * own or descendant activity), title, relative time, and the row actions menu.
 * @param props.node - derived session node.
 * @param props.currentId - selected session id (row highlight).
 * @param props.now - epoch ms for relative-time formatting.
 * @param props.onOpen - open a session by id.
 * @param props.onRename - open the session rename dialog (id + current title).
 * @param props.onFork - fork a session at its last completed turn.
 * @param props.onArchive - archive a session by id.
 * @param props.seat - the row's place in the list's tab order.
 * @param props.selection - multi-selection wiring; absent where range selection does not apply.
 * @param props.drag - optional draggable-row wiring.
 * @param props.flat - omit the empty status slot in the hierarchy-free flat list.
 * @param props.t - the browser root's locale seat.
 * @returns the session row.
 */
export function SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, seat, selection, drag, flat = false, t }: {
  node: SessionNode
  currentId: string | undefined
  now: number
  onOpen: (id: SessionNode['id']) => void
  /** Open the browser-owned session rename dialog (row menu action). */
  onRename: (id: SessionNode['id'], currentTitle: string) => void
  /** Fork a session at its last completed turn (row menu action). */
  onFork: (id: SessionNode['id']) => void
  /** Archive this session (row menu action; commits without a dialog). */
  onArchive: (id: SessionNode['id']) => void
  /** The row's place in the list's tab order; every rendered row has one. */
  seat: RowSeat
  /**
   * Multi-selection wiring. Absent on rows a range cannot address: the
   * provisional blank New Session, which has no row verbs at all, and search
   * results, whose list is a filtered projection rather than an account.
   */
  selection?: RowMultiSelection | undefined
  /** Present only on draggable rows (workspace-group sessions outside search). */
  drag?: RowDragProps | undefined
  /** The row is rendered without a parent Workspace header. */
  flat?: boolean | undefined
  t: RowTranslate
}) {
  const row = node
  const title = displayTitle(node, t)
  const selected = node.id === currentId
  const statuses = sessionStatuses(node, t)
  const primaryStatus = statuses[0]
  const showStatus = primaryStatus.state !== 'done' || row.completed
  const menu = useRowMenu()
  const menuOpen = menu.open
  const inSelection = selection?.active === true
  const bulk = widenedSelection(selection)
  // Archive hides the row through the registry-global archive set and never
  // touches the session log, so it is not styled as destructive and needs no
  // confirmation dialog.
  const sessionMenuItems = bulk === undefined
    ? [
      { id: 'rename', label: t('rename'), icon: <IconEditOutline16 /> },
      { id: 'fork', label: t('menu.fork'), icon: <IconBranchOutline16 /> },
      // 20-native glyph in the menu's 16px icon slot (Menu.module.css .itemIcon).
      { id: 'archive', label: t('menu.archiveSession'), icon: <IconArchiveOutline20 size={16} /> },
    ]
    : bulkArchiveItems(bulk, t)
  // Figma session cell: pad 8, status slot 16, then a 4px title gap.
  const ownRow = (
    <div
      className={clsx(
        css.sessionRow, selected && css.selected, menuOpen && css.menuOpen,
        inSelection && css.multiSelected,
        flat && !showStatus && css.flatSessionRowWithoutStatus,
        drag?.marker === 'before' && css.dropBefore, drag?.marker === 'after' && css.dropAfter,
      )}
      role="treeitem"
      aria-level={seat.level}
      // The open Session is the list's current row, not a range member. A tree
      // that declares `aria-multiselectable` has to keep the two apart, or the
      // set a reader hears as selected is not the set a bulk archive commits.
      {...selected ? { 'aria-current': true } : {}}
      // Only a row a range can reach reports selection state, on the same terms
      // the Ungrouped bucket does: a blank draft promises no selection either.
      {...selection === undefined ? {} : { 'aria-selected': selection.active }}
      tabIndex={seat.seated ? 0 : -1}
      data-row-key={seat.rowKey}
      data-row-label={title}
      onClick={(e) => {
        // A modified click edits the range instead of opening the Session.
        if (selectionTookClick(selection, menuOpen, e)) return
        onOpen(node.id)
      }}
      onKeyDown={(e) => {
        if (!rowOwnsKey(e, menuOpen)) return
        // A leaf's collapse key steps out to the header it sits under; the
        // flat list has none and holds.
        if (e.key === 'ArrowLeft') {
          seat.move('parent', false)
          e.preventDefault()
          return
        }
        rowKeyDown(seat, selection, () => { onOpen(node.id) }, e)
      }}
      // The row menu is absent on a blank row, so its right-click answer is too.
      onContextMenu={row.blank
        ? undefined
        : (e) => { openRowMenu(menu, selection, e) }}
      draggable={drag !== undefined}
      onDragStart={drag === undefined
        ? undefined
        : (e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.id)
          drag.start()
        }}
      onDragEnd={drag?.end}
      onDragOver={drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          drag.hover(rowHalf(e))
        }}
      onDrop={drag === undefined
        ? undefined
        : (e) => {
          if (!drag.active) return
          e.preventDefault()
          drag.drop(rowHalf(e))
        }}
    >
      {/* Pending interaction and own or descendant activity outrank the
          finished-but-unviewed reminder, which returns after activity stops
          and is cleared by opening the session. */}
      {(!flat || showStatus) && (
        <span className={css.slot}>
          {showStatus && <SessionStatusDots statuses={statuses} />}
        </span>
      )}
      <span className={css.title}>{title}</span>
      {/* A blank New Session row is a provisional placeholder: nothing has
          happened in it yet, so a "now" timestamp and the row verbs
          (rename/fork/archive) would all act on content that does not
          exist — both trailing cells stay off until the first prompt. */}
      {!row.blank && <span className={css.time}>{timeLabel(row.updatedAt, now, t)}</span>}
      {!row.blank && (
        <span className={css.rowActions}>
          <Menu
            open={menuOpen}
            onClose={menu.close}
            items={sessionMenuItems}
            onSelect={(id) => {
              menu.close()
              // The widened list carries the bulk row alone, so it needs no id test.
              if (bulk !== undefined) { bulk.archiveSelected(); return }
              if (id === 'rename') onRename(node.id, row.title)
              if (id === 'fork') onFork(node.id)
              if (id === 'archive') onArchive(node.id)
            }}
            portal
            closeOnPointerLeave
            autoFocus={menu.autoFocus}
            ariaLabel={t('actions.session.aria', { name: title })}
            {...menu.anchorProps}
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('actions.session.aria', { name: title })}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={menu.toggle}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        </span>
      )}
    </div>
  )
  return (
    <HoverCard
      // The row is a treeitem its tree owns; a generic wrapper between the two
      // would break that ownership.
      presentational
      anchor={ownRow}
      content={<SessionHoverContent node={node} now={now} t={t} />}
      disabled={menuOpen || drag?.active === true}
      copyText={row.blank ? undefined : row.title}
      copyLabel={t('copy')}
      copiedLabel={t('hover.copied')}
    />
  )
}
