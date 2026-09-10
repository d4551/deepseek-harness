/** Settings sections and localized chrome are supplied by the slot registry. */
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  Button, Modal, PanelActions, IconAgentPresetOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 size={16} />
  return <IconSettingsOutline16 size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/** Registered sections inside the shared accessible dialog. */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  return (
    <Modal
      open
      size="workspace"
      initialFocus="close"
      title={<>{renderSlot('settings.header', {})}</>}
      closeLabel={<>{renderSlot('settings.close', {})}</>}
      headerActions={renderSlot('settings.action', {})}
      onClose={onClose}
      navigation={(
        <nav>
          <PanelActions>
            {rows.map(row => (
              <Button
                key={row.id}
                size="touch"
                icon={navIcon(row.id)}
                variant={row.id === active ? 'toolbar' : 'ghost'}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {row.label}
              </Button>
            ))}
          </PanelActions>
        </nav>
      )}
    >
      {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
    </Modal>
  )
}

/**
 * Render the settings trigger, registered sections and ordered onboarding steps.
 * @param props - composed settings slot props.
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { wide, useSections, useOnboardingSteps, useSessions, renderSlot } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])
  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
        />
      )}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
