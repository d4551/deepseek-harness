import { memo } from 'react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { TurnLimitNotice } from './TurnLimitNotice.tsx'

/** Render exact host usage and explicit human continuation instructions. */
export const TurnRequestBudgetNodeView = memo(function TurnRequestBudgetNodeView({
  node, t,
}: Pick<ChatNodeViewProps<'turn-request-budget'>, 'node' | 't'>) {
  const budget = node.data.budget
  const rootLimitReached = budget.actorSessionId === budget.rootSessionId && budget.rootAttempts >= budget.maxRootAttempts
  return (
    <TurnLimitNotice
      title={t('message.requestBudget')}
      hint={t('message.requestBudget.hint')}
      usage={t('message.requestBudget.usage', {
        actor: budget.actorAttempts,
        actorLimit: rootLimitReached ? budget.maxRootAttempts : budget.maxAgentAttempts,
        root: budget.rootAttempts, rootLimit: budget.maxRootAttempts,
      })}
    />
  )
})
