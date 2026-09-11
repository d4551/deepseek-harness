// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TeamMessageId } from '../../../subagent/agent-team/src/types.ts'
import { TeamConversations, type TeamConversation } from '../src/client/TeamConversations.tsx'
import { TeamMessages } from '../src/client/TeamMessages.tsx'
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
  const current = { ...view, messages: [
    message, { ...message, id: TeamMessageId('message-2'), delivered: false },
  ] }
  render(<>
    <TeamMessages view={current} t={key => en[key]} />
    <TeamConversations load={() => Promise.resolve({ ok: true, value: [child] })} view={current}
      t={key => en[key]} open={async (entry) => { opened.push(entry) }} reportError={(reason) => { errors.push(reason) }} />
  </>)
  expect(await screen.findByRole('table', { name: 'Subagent conversations' })).toBeTruthy()
  expect(screen.getByRole('cell', { name: 'worker' })).toBeTruthy()
  expect(screen.getByText('Inactive')).toBeTruthy()
  expect(screen.queryByText('Review complete')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'lead ↔ worker' }))
  expect(screen.getByText('Queued')).toBeTruthy()
  expect(screen.getAllByText('worker → lead')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Older message' }))
  expect(screen.getByText('Delivered')).toBeTruthy()
  expect(screen.queryByText('Queued')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Newer message' }))
  expect(screen.getByText('Queued')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Nested worker/u }))
  await Promise.resolve()
  expect(opened).toEqual([child])
  expect(errors).toEqual([])
})

it('groups both directions and keeps the selected historical message stable when new messages arrive', () => {
  const messages: typeof view.messages = Array.from({ length: 100 }, (_, index) => ({
    id: TeamMessageId(`history-${index}`),
    senderId: SessionId(index % 2 === 0 ? 'worker-id' : 'lead'),
    senderName: index % 2 === 0 ? 'worker' : 'lead',
    targetId: SessionId(index % 2 === 0 ? 'lead' : 'worker-id'),
    delivery: 'quiet', delivered: true,
    content: [{ type: 'text', text: `Report ${index}` }],
  }))
  const rendered = render(<TeamMessages view={{ ...view, messages }} t={key => en[key]} />)
  expect(screen.queryByText('Report 99')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'lead ↔ worker' }))
  expect(screen.getByText('Report 99')).toBeTruthy()
  expect(screen.queryByText('Report 98')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Older message' }))
  expect(screen.getByText('Report 98')).toBeTruthy()
  const last = messages.at(-1)
  if (last === undefined) throw new Error('History requires a latest message')
  rendered.rerender(<TeamMessages view={{ ...view, messages: [...messages, {
    ...last, id: TeamMessageId('history-100'), content: [{ type: 'text', text: 'Report 100' }],
  }] }} t={key => en[key]} />)
  expect(screen.getByText('Report 98')).toBeTruthy()
  expect(screen.queryByText('Report 100')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Newer message' }))
  fireEvent.click(screen.getByRole('button', { name: 'Newer message' }))
  expect(screen.getByText('Report 100')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search message text' }), { target: { value: 'Report 42' } })
  expect(screen.getByText('Report 42')).toBeTruthy()
  expect(screen.queryByText('Report 100')).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search message text' }), { target: { value: 'Absent phrase' } })
  expect(screen.getByRole('status').textContent).toBe('No matching messages')
})
