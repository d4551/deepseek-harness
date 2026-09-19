/** Composer takeover for one pending approval waterfall. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalComposerProps, PendingApproval } from './contract/slots.ts'
import css from './ApprovalPanel.module.css'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

function thrownMessage(reason: Thrown): string {
  if (reason instanceof Error) return reason.message
  switch (typeof reason) {
    case 'string': return reason
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(reason)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (reason === null) return 'null'
      return Object.prototype.toString.call(reason)
  }
}

/**
 * Render one pending approval and its optional Tool-owned detail.
 * @param props - selector-matched request and standard Slot props.
 * @returns The approval composer takeover.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = props.matched
  const detail = approval.callId === undefined
    ? null
    : props.renderSlot('conversation.approval.detail', { callId: approval.callId })
  return <ApprovalFlow key={approval.key} pending={approval} detail={detail} t={props.t} />
}

function ApprovalFlow({ pending, detail, t }: {
  pending: PendingApproval
  detail: ReactNode
  t: ApprovalComposerProps['t']
}) {
  const [answered, setAnswered] = useState(false)
  const [answerError, setAnswerError] = useState<string | null>(null)
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    setAnswered(true)
    setAnswerError(null)
    pending.answer(outcome).then(
      undefined,
      (reason: Thrown) => {
        setAnswered(false)
        setAnswerError(thrownMessage(reason))
      },
    )
  }
  return (
    <div className={css.root} data-approval-key={pending.key}>
      <div className={css.card}>
        <div className={css.strip}><span className={css.dot} />{t('waiting')}</div>
        <fieldset className={css.body} data-approval-scroll="">
          <legend className="dsw-visually-hidden">{t('detail.aria')}</legend>
          <div className={css.headline}>{pending.reason ?? t('escalation', { toolName: pending.toolName })}</div>
          {detail !== null && <div className={css.command}>{detail}</div>}
        </fieldset>
        {answerError !== null && <div className={css.headline} role="alert">{answerError}</div>}
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered} onClick={() => { answer('rejected') }}>
            {t('reject')}
          </Button>
          <Button variant="primary" disabled={answered} onClick={() => { answer('allowed-once') }}>
            {t('allowOnce')}
          </Button>
        </div>
      </div>
    </div>
  )
}
