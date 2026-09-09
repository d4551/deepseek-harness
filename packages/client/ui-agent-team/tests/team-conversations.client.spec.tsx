// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TeamMessageId } from '../../../subagent/agent-team/src/types.ts'
import { TeamConversations, type TeamConversation } from '../src/client/TeamConversations.tsx'
import { en } from '../src/client/locales.ts'
import { view } from './team-fixtures.client.ts'

afterEach(cleanup)

it('shows nested worker status and both delivered and queued peer messages', async () => {
  const parent = SessionId('worker-id')
  const child: TeamConversation = {
    kind: 'child', id: SessionId('nested'), parentId: parent, depth: 2,
    mode: 'one-shot', activity: 'inactive', label: 'Nested worker', hasChildren: false,
  }
  const opened: TeamConversation[] = []
  const errors: unknown[] = []
  const message = {
    id: TeamMessageId('message-1'), senderId: parent, senderName: 'worker', targetId: SessionId('lead'),
    delivery: 'quiet', content: [{ type: 'text', text: 'Review complete' }], delivered: true,
  } satisfies (typeof view.messages)[number]
  render(<TeamConversations view={{ ...view, subagents: [child], messages: [
    message, { ...message, id: TeamMessageId('message-2'), delivered: false },
  ] }} t={key => en[key]} open={async (entry) => { opened.push(entry) }} reportError={(reason) => { errors.push(reason) }} />)
  expect(screen.getByText('Parent: worker · Inactive')).toBeTruthy()
  expect(screen.getByText('Delivered')).toBeTruthy()
  expect(screen.getByText('Queued')).toBeTruthy()
  expect(screen.getAllByText('worker → lead')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: /Nested worker/u }))
  await Promise.resolve()
  expect(opened).toEqual([child])
  expect(errors).toEqual([])
})
