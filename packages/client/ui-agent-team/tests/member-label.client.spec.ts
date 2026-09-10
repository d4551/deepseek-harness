import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamMemberView } from '@deepseek-ai/dsh-agent-team/client'
import { memberLabel } from '../src/client/member-label.ts'
import { en, zh } from '../src/client/locales.ts'

describe('Team member display names', () => {
  const peer: TeamMemberView = {
    id: SessionId('review-session'),
    name: 'session:review-session',
    role: 'peer',
    status: 'idle',
    diagnostics: [],
  }

  it('uses a peer conversation title without changing its routing identity', () => {
    const titled = { ...peer, title: 'Review keyboard navigation' }
    expect(memberLabel(titled, key => en[key])).toBe('Review keyboard navigation')
    expect(titled.name).toBe('session:review-session')
  })

  it('localizes an untitled peer conversation', () => {
    expect(memberLabel(peer, key => en[key])).toBe('Untitled conversation')
    expect(memberLabel(peer, key => zh[key])).toBe('未命名会话')
  })

  it('localizes a conversation whose member record is unavailable', () => {
    expect(memberLabel(undefined, key => en[key])).toBe('Untitled conversation')
    expect(memberLabel(undefined, key => zh[key])).toBe('未命名会话')
  })

  it('preserves the lead name when its session also has a title', () => {
    expect(memberLabel({ ...peer, role: 'lead', name: 'lead', title: 'Project review' }, key => en[key]))
      .toBe('lead')
  })

  it('preserves an assigned teammate name when its session has a title', () => {
    expect(memberLabel({ ...peer, role: 'teammate', name: 'reviewer', title: 'Project review' }, key => en[key]))
      .toBe('reviewer')
  })
})
