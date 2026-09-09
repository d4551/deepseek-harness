import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamJournal } from './journal.ts'
import type { TeamOverview } from './types.ts'
import { TeamId } from './types.ts'

/** Project outgoing messages and authorized peer replies from their owning journals. */
export function teamMessageView(root: Agent, peers: readonly Agent[], journal: TeamJournal): TeamOverview['messages'] {
  const owned = journal.state(root)
  const recipients = new Set([root.id, ...owned.members.keys()])
  return [root, ...peers].flatMap((source) => {
    const state = source === root ? owned : journal.state(source)
    return source.session.events.flatMap((event) => {
      if (event.type !== 'team/message/queued' || event.data.teamId !== TeamId(source.id)) return []
      const message = state.messages.get(event.data.message.id)
      if (message === undefined || (source !== root && !recipients.has(message.targetId))) return []
      return [{ time: event.time, message: { ...message, delivered: state.delivered.has(message.id) } }]
    })
  }).sort((left, right) => left.time - right.time).map(entry => entry.message)
}
