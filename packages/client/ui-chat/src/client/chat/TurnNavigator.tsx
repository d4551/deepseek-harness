import {
  memo, useId, useState, type CSSProperties,
} from 'react'
import { GlyphButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnNavigationItem } from '../contract/snapshot.ts'
import css from './TurnNavigator.module.css'

interface TurnNavigatorProps {
  readonly items: readonly TurnNavigationItem[]
  readonly activeTurn: number | null
  readonly onNavigate: (item: TurnNavigationItem) => void
  readonly t: ChatViewSlotProps['t']
}

/** Each turn has a distinct pointer and keyboard target. */
const TURN_SPACING_PX = 28
type TurnPositionStyle = CSSProperties & {
  readonly '--turn-natural-position': string
}

type TurnRailStyle = CSSProperties & {
  readonly '--turn-natural-height': string
}

function itemPosition(index: number): TurnPositionStyle {
  return {
    '--turn-natural-position': `${String(index * TURN_SPACING_PX)}px`,
  }
}

function railSize(count: number): TurnRailStyle {
  return {
    '--turn-natural-height': `${String(count * TURN_SPACING_PX)}px`,
  }
}

function TurnNavigatorRail({ items, activeTurn, onNavigate, t }: TurnNavigatorProps) {
  const [previewTurn, setPreviewTurn] = useState<number | null>(null)
  const previewId = useId()
  if (items.length < 2) return null
  const previewIndex = items.findIndex(item => item.turn === previewTurn)
  const preview = previewIndex < 0 ? undefined : items[previewIndex]
  return (
    <div className={css.slot}>
      <nav
        className={css.rail}
        style={railSize(items.length)}
        aria-label={t('chat.turnNavigation.label')}
        onPointerLeave={() => { setPreviewTurn(null) }}
      >
        <div className={css.marks} onScroll={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) setPreviewTurn(null)
        }}>
          {items.map((item, index) => {
            const active = item.turn === activeTurn
            const showingPreview = item.turn === previewTurn
            const markClass = active
              ? `${css.mark} ${css.markActive}`
              : showingPreview ? `${css.mark} ${css.markPreview}` : css.mark
            return (
              <div key={item.turn} className={css.markPosition} style={itemPosition(index)}>
                <GlyphButton
                  surface="header"
                  className={markClass}
                  aria-label={t('chat.turnNavigation.jump', { turn: item.turn })}
                  aria-current={active ? 'true' : undefined}
                  aria-describedby={showingPreview ? previewId : undefined}
                  onPointerMove={() => { setPreviewTurn(item.turn) }}
                  onClick={(event) => {
                    event.stopPropagation()
                    onNavigate(item)
                  }}
                  onFocus={() => { setPreviewTurn(item.turn) }}
                  onBlur={() => { setPreviewTurn(null) }}
                />
              </div>
            )
          })}
        </div>
        {preview !== undefined && (
          <div id={previewId} role="tooltip" className={css.preview}>
            <div className={css.previewPrompt}>
              {preview.prompt || t('chat.turnNavigation.turn', { turn: preview.turn })}
            </div>
            {preview.response !== '' && <div className={css.previewResponse}>{preview.response}</div>}
          </div>
        )}
      </nav>
    </div>
  )
}

/**
 * Compact rail of the currently loaded Turns with hover and focus previews.
 *
 * Memoized because it renders two host elements per loaded Turn while the
 * enclosing view re-renders on every streaming delta: without the guard a long
 * session rebuilds hundreds of marks per commit for a rail that only changes
 * when a Turn is added, removed, or becomes active. Its props must therefore
 * stay referentially stable across those commits.
 */
export const TurnNavigator = memo(TurnNavigatorRail)
