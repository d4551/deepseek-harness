import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MessageItem.module.css'

/** Persistent notice for a host or provider limit; continuation remains a user action. */
export function TurnLimitNotice({ title, hint, usage }: { title: string; hint: string; usage?: string }) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnLimitTitle}>{title}</span>
        {usage !== undefined && <span className={css.turnErrorMessage}>{usage} </span>}
        <span className={css.turnErrorMessage}>{hint}</span>
      </div>
    </div>
  )
}
