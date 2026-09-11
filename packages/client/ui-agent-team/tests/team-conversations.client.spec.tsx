// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

it('indexes separate conversations by latest activity and announces the reader position and boundaries', () => {
  const message = (id: string, sender: string, text: string): (typeof view.messages)[number] => ({
    id: TeamMessageId(id), senderId: SessionId(sender), senderName: sender,
    targetId: SessionId('lead'), delivery: 'quiet', delivered: true, content: [{ type: 'text', text }],
  })
  render(<TeamMessages view={{ ...view, messages: [
    message('one', 'worker-id', 'First report'),
    message('two', 'archived-worker', 'Archived report'),
    message('three', 'worker-id', 'Latest report'),
  ] }} t={key => en[key]} />)
  const region = screen.getByRole('region', { name: en.messages })
  expect(within(region).getByText(en.messagesDescription)).toBeTruthy()
  expect(within(region).queryByText(en.noMessages)).toBeNull()
  expect(within(region).queryByRole('status')).toBeNull()
  const table = screen.getByRole('table', { name: en.messages })
  expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual(['Conversation', 'Messages'])
  expect(within(table).getAllByRole('rowheader').map(header => header.textContent)).toEqual([
    'lead ↔ worker', 'archived-worker ↔ lead',
  ])
  expect(within(table).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['2', '1'])
  const thread = screen.getByRole('button', { name: 'lead ↔ worker', expanded: false })
  fireEvent.click(thread)
  expect(thread.getAttribute('aria-expanded')).toBe('true')
  const detailId = thread.getAttribute('aria-controls')
  if (detailId === null) throw new Error('Conversation control has no reader association')
  expect(document.getElementById(detailId)?.textContent).toContain('Latest report')
  expect(screen.getByText('2 / 2')).toBeTruthy()
  const older = screen.getByRole('button', { name: en.olderMessage })
  const newer = screen.getByRole('button', { name: en.newerMessage })
  expect(older.hasAttribute('disabled')).toBe(false)
  expect(newer.hasAttribute('disabled')).toBe(true)
  expect(older.getAttribute('title')).toBe(en.olderMessage)
  expect(newer.getAttribute('title')).toBe(en.newerMessage)
  expect(older.getAttribute('aria-label')).toBe(en.olderMessage)
  expect(newer.getAttribute('aria-label')).toBe(en.newerMessage)
  fireEvent.click(older)
  expect(screen.getByText('1 / 2')).toBeTruthy()
  expect(screen.getByRole('button', { name: en.olderMessage }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: en.newerMessage }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(thread)
  expect(screen.queryByText('First report')).toBeNull()
  expect(thread.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(thread)
  expect(screen.getByText('Latest report')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'archived-worker ↔ lead' }))
  expect(screen.getByText('Archived report')).toBeTruthy()
  expect(screen.queryByText('Latest report')).toBeNull()
  expect(screen.getByText('1 / 1')).toBeTruthy()
})

it('searches visible text across blocks, preserves paragraphs, and identifies non-text content', () => {
  const first: (typeof view.messages)[number] = {
    id: TeamMessageId('mixed-content'), senderId: SessionId('departed'), senderName: 'Departed reviewer',
    targetId: SessionId('missing-recipient'), delivery: 'quiet', delivered: true,
    content: [
      { type: 'text', text: 'First paragraph' },
      { type: 'reasoning', text: 'Internal analysis' },
      { type: 'text', text: 'Second paragraph' },
    ],
  }
  const last: (typeof view.messages)[number] = {
    ...first, id: TeamMessageId('latest-content'), content: [{ type: 'text', text: 'Latest report' }],
  }
  render(<TeamMessages view={{ ...view, messages: [first, last] }} t={key => en[key]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Departed reviewer ↔ Untitled conversation' }))
  expect(screen.queryByText(en.messageAttachments)).toBeNull()
  const search = screen.getByRole('textbox', { name: en.searchMessages })
  fireEvent.change(search, { target: { value: '  SECOND PARAGRAPH  ' } })
  expect(screen.getByText('First paragraph Second paragraph').textContent).toBe('First paragraph\nSecond paragraph')
  expect(screen.getByText(en.messageAttachments)).toBeTruthy()
  expect(screen.queryByText('Internal analysis')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.change(search, { target: { value: 'Internal analysis' } })
  expect(screen.getByRole('status').textContent).toBe(en.noMatchingMessages)
  expect(screen.queryByRole('table')).toBeNull()
  fireEvent.change(search, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: en.olderMessage }))
  expect(screen.getByText(en.messageAttachments)).toBeTruthy()
  fireEvent.change(search, { target: { value: 'report' } })
  fireEvent.change(search, { target: { value: '' } })
  expect(screen.getByText('Latest report')).toBeTruthy()
})

it('keeps an empty message panel distinct from an empty search result', () => {
  render(<TeamMessages view={view} t={key => en[key]} />)
  expect(screen.getByRole('region', { name: en.messages })).toBeTruthy()
  expect(screen.getByText(en.noMessages)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it('includes messages without text until the reader searches and refreshes member titles live', () => {
  const messages: typeof view.messages = [{
    id: TeamMessageId('attachment-only'), senderId: SessionId('worker-id'), senderName: 'worker',
    targetId: SessionId('lead'), delivery: 'quiet', delivered: true,
    content: [{ type: 'reasoning', text: 'Private analysis' }],
  }]
  const rendered = render(<TeamMessages view={{ ...view, messages }} t={key => en[key]} />)
  fireEvent.click(screen.getByRole('button', { name: 'lead ↔ worker' }))
  expect(screen.getByText(en.messageAttachments)).toBeTruthy()
  expect(screen.queryByText('Private analysis')).toBeNull()
  rendered.rerender(<TeamMessages view={{ ...view, messages, members: view.members.map(member => ({
    ...member, name: `${member.name} renamed`,
  })) }} t={key => en[key]} />)
  expect(screen.getByRole('button', { name: 'lead renamed ↔ worker renamed', expanded: true })).toBeTruthy()
  expect(screen.getByText('worker renamed → lead renamed')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: en.searchMessages }), { target: { value: 'Private analysis' } })
  expect(screen.getByRole('status').textContent).toBe(en.noMatchingMessages)
  expect(screen.queryByText(en.messageAttachments)).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: en.searchMessages }), { target: { value: '' } })
  expect(screen.getByText(en.messageAttachments)).toBeTruthy()
})
