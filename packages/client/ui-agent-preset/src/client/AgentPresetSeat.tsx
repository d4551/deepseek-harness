/**
 * The agent-preset chip on the new-session screen, beside the workspace
 * picker.
 *
 * It lives here rather than in the composer because the choice is only
 * available before a conversation starts: once a turn has run, the session's
 * history was produced under that preset's tools and the host refuses to swap
 * them. A control that spends most of its life disabled belongs on the screen
 * where it still works.
 *
 * The menu opens on the staged choice, which starts as the deployment default.
 * Picking stages; the choice reaches a session when one becomes current.
 */

import { useEffect, useRef, useState, useTransition } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconAgentPresetOutline16, IconChevronDownOutline14, IconWarningOutline16, Menu, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the hero seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentPresetSeatState } from './seat-store.ts'
import { presetDisplayText } from './locales.ts'
import css from './AgentPresetSeat.module.css'

/** Registration-side business face for the hero chip. */
export interface AgentPresetSeatInjected {
  hooks: {
    /** Seat snapshot bound by the renderer as useAgentPresetSeat. */
    agentPresetSeat: SnapshotStore<AgentPresetSeatState>
  }
  /** Read the roster when the chip first renders. */
  load: () => Promise<void>
  /** Stage one preset for the next session; resolves to a refusal, or undefined. */
  select: (id: string) => Promise<string | undefined>
  /** Clear the one-shot introduce cue once the chip has played it. */
  introduced: () => void
}

/**
 * How long a refused switch holds before fading.
 *
 * Longer than the primitive's default because this banner is the only place
 * the refusal appears. The chip's label has already snapped back to the
 * preset the session still runs, and a preset the host refuses to MOUNT is
 * one discovery reported healthy — its row on the settings page carries no
 * reason to go back and read, because there was nothing to see until the
 * rows actually ran.
 */
const REFUSAL_HOLD_MS = 8000

/** Full component props. */
export type AgentPresetSeatProps =
  PropsRuntime<'conversation.hero.agentPreset'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetSeatInjected>

/**
 * Render the new-session agent-preset chip.
 * @param props - composed slot props.
 * @returns the chip, or null when the deployment composes no presets.
 */
export function AgentPresetSeat({ load, select, introduced, useAgentPresetSeat, t }: AgentPresetSeatProps) {
  const state = useAgentPresetSeat(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [, startTransition] = useTransition()
  // The seq keys the banner, so picking the same broken preset twice replays
  // it rather than leaving the first one silently in place.
  const toastSeq = useRef(0)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)

  useEffect(() => {
    startTransition(load)
  }, [load, startTransition])

  const chosen = state.options.find(option => option.id === state.current)
  const chosenText = chosen === undefined ? undefined : presetDisplayText(chosen, t)
  const label = chosenText?.name ?? state.current
  const ready = state.options.length > 0 && state.current !== ''

  // The introduce cue: the pick was staged from another screen (the settings
  // creator entry), so the chip announces it — the icon eases in and each
  // character of the name fades up on a stagger (CSS owns the motion; this
  // effect only arms it and acknowledges the cue once the run is over).
  const [introducing, setIntroducing] = useState(false)
  useEffect(() => {
    if (!state.introduce || !ready) return
    const characters = Array.from(label)
    if (characters.length === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      introduced()
      return
    }
    setIntroducing(true)
  }, [state.introduce, ready, label, introduced])

  // Nothing to choose between: the deployment composes no presets and every
  // session shares the host composition.
  if (!ready) return null

  // One wrapper span: the chip is a flex row with a gap, so loose character
  // spans would each pick up the gap between them.
  const characters = Array.from(label)
  const shownLabel = introducing
    ? (
      <span className={css.introText}>
        {characters.map((character, index) => (
          <span
            key={index}
            className={css.introChar}
            data-character-index={index}
            data-character-count={characters.length}
            onAnimationEnd={index === characters.length - 1 ? () => {
              setIntroducing(false)
              introduced()
            } : undefined}
          >
            {character}
          </span>
        ))}
      </span>
    )
    : label

  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={state.options.map((option) => {
          const text = presetDisplayText(option, t)
          return {
            id: option.id,
            // Name and description together: the id alone never says what a
            // preset does, which is why the roster carries display copy.
            label: (
              <span className={css.item}>
                <span className={css.itemName}>{text.name}</span>
                <span className={css.itemDesc}>{text.description ?? t('noDescription')}</span>
              </span>
            ),
          }
        })}
        selectedId={state.current}
        onSelect={(id) => {
          setOpen(false)
          const picked = state.options.find(option => option.id === id)
          if (picked === undefined) throw new Error('Selected preset is absent from the current roster')
          const name = presetDisplayText(picked, t).name
          startTransition(async () => {
            const refusal = await select(id)
            // Announced only for a pick a person just made: `apply()` also runs
            // when a session becomes current, and a banner over that would
            // report a refusal nobody asked for.
            if (refusal === undefined) return
            toastSeq.current += 1
            setToast({ seq: toastSeq.current, text: t('switchRefused', { name, reason: refusal }) })
          })
        }}
        align="start"
        portal
        anchor={(
          <Button
            size="touch"
            className={css.seat}
            aria-haspopup="menu"
            aria-expanded={open}
            title={state.error ?? t('seatHint')}
            disabled={state.busy}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconAgentPresetOutline16 className={introducing ? `${css.seatIcon} ${css.introIcon}` : css.seatIcon} />
            {shownLabel}
            <IconChevronDownOutline14 className={css.chevron} />
          </Button>
        )}
      />
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          holdMs={REFUSAL_HOLD_MS}
          // The composer card, which is the content column this chip sits
          // above rather than inside — hence a page query, not `closest`.
          // Absent, the banner centers on the window, which is off-center
          // whenever the sidebar is open.
          anchor={document.querySelector<HTMLElement>('[data-composer-card]')}
          onDone={() => { setToast(null) }}
        />
      )}
    </>
  )
}
