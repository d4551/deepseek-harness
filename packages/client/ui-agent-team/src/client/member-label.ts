import type { TeamMemberView } from '@deepseek-ai/dsh-agent-team/client'
import type { TeamKey } from './locales.ts'

/** Display conversation titles while preserving stable names for Team routing. */
export function memberLabel(member: TeamMemberView | undefined, t: (key: TeamKey) => string): string {
  if (member === undefined) return t('untitledConversation')
  return member.role === 'peer' ? member.title ?? t('untitledConversation') : member.name
}
