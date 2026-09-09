import { memo, useState } from 'react'
import { Button, IconChecklistOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnNavigationItem } from '../contract/snapshot.ts'

interface TurnNavigatorProps {
  readonly items: readonly TurnNavigationItem[]
  readonly activeTurn: number | null
  readonly onNavigate: (item: TurnNavigationItem) => void
  readonly t: ChatViewSlotProps['t']
}

function TurnNavigatorMenu({ items, activeTurn, onNavigate, t }: TurnNavigatorProps) {
  const [open, setOpen] = useState(false)
  if (items.length < 2) return null
  const label = t('chat.turnNavigation.label')
  return (
    <nav aria-label={label}>
      <Menu
        open={open}
        ariaLabel={label}
        autoFocus
        selectedId={activeTurn === null ? undefined : String(activeTurn)}
        anchor={(
          <Button aria-expanded={open} aria-haspopup="menu" icon={<IconChecklistOutline14 />}
            onClick={() => { setOpen(!open) }}>{label}</Button>
        )}
        items={items.map(item => ({
          id: String(item.turn),
          label: `${t('chat.turnNavigation.jump', { turn: item.turn })}: ${item.prompt || t('chat.turnNavigation.turn', { turn: item.turn })} ${item.response}`,
        }))}
        onSelect={(id) => {
          const item = items.find(candidate => String(candidate.turn) === id)
          if (item === undefined) throw new Error(`Turn navigation item ${id} is unavailable`)
          onNavigate(item)
          setOpen(false)
        }}
        onClose={() => { setOpen(false) }}
      />
    </nav>
  )
}

/** Navigate the loaded conversation turns through the shared keyboard-accessible menu. */
export const TurnNavigator = memo(TurnNavigatorMenu)
