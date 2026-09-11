import { useId, useMemo, useState } from 'react'
import type { TeamOverview } from '@deepseek-ai/dsh-agent-team/client'
import {
  Button, Input, PanelTable, PanelSection, PanelEntry, PanelActions, PanelField, MessageBody, Pill,
  IconChevronLeftOutline14, IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'
import { memberLabel } from './member-label.ts'

/** Durable messages indexed by conversation, with one historical message open at a time. */
export function TeamMessages({ view, t }: { view: TeamOverview; t: (key: TeamKey) => string }) {
  const [opened, setOpened] = useState<string | null>(null)
  const [selectedMessage, setSelectedMessage] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const detailId = useId()
  const search = query.trim().toLocaleLowerCase()
  const threads = useMemo(() => {
    const grouped = new Map<string, TeamOverview['messages']>()
    for (const message of view.messages) {
      if (search !== '' && !message.content.some(block => block.type === 'text'
        && block.text.toLocaleLowerCase().includes(search))) continue
      const key = JSON.stringify([message.senderId, message.targetId].sort())
      const messages = grouped.get(key) ?? []
      messages.push(message)
      grouped.delete(key)
      grouped.set(key, messages)
    }
    return grouped
  }, [view.messages, search])
  const members = useMemo(() => new Map(view.members.map(member => [member.id, member])), [view.members])
  const nameOf = (id: TeamOverview['messages'][number]['senderId'], recordedName?: string): string => {
    const member = members.get(id)
    return member === undefined && recordedName !== undefined ? recordedName : memberLabel(member, t)
  }
  const messages = opened === null ? [] : threads.get(opened) ?? []
  const message = messages.find(candidate => candidate.id === selectedMessage) ?? messages.at(-1)
  const index = message === undefined ? -1 : messages.indexOf(message)
  const older = messages[index - 1]
  const newer = messages[index + 1]
  return <PanelSection title={t('messages')} description={t('messagesDescription')} actions={<Pill>{view.messages.length}</Pill>}>
    {view.messages.length === 0 && <p>{t('noMessages')}</p>}
    {view.messages.length > 0 && <PanelField label={t('searchMessages')}>
      <Input value={query} onChange={(event) => {
        setQuery(event.currentTarget.value)
        setSelectedMessage(null)
      }} />
    </PanelField>}
    {search !== '' && threads.size === 0 && <p role="status">{t('noMatchingMessages')}</p>}
    {threads.size > 0 && <PanelTable label={t('messages')} columns={[t('conversation'), t('messageCount')]}>
      {[...threads].reverse().map(([key, entries]) => {
        const latest = entries.at(-1)
        if (latest === undefined) return null
        const title = [nameOf(latest.senderId, latest.senderName), nameOf(latest.targetId)].sort().join(' ↔ ')
        return <tr key={key}>
          <th scope="row"><Button aria-expanded={opened === key} aria-controls={detailId} onClick={() => {
            setOpened(opened === key ? null : key)
            setSelectedMessage(null)
          }}>{title}</Button></th>
          <td>{entries.length}</td>
        </tr>
      })}
    </PanelTable>}
    <div id={detailId}>
      {message !== undefined && <PanelEntry key={message.id}>
        <PanelActions>
          <span className="dsw-settings-cell-title">{nameOf(message.senderId, message.senderName)} → {nameOf(message.targetId)}</span>
          <Pill>{t(message.delivered ? 'delivered' : 'queued')}</Pill>
        </PanelActions>
        <PanelActions>
          <Button size="touch" aria-label={t('olderMessage')} title={t('olderMessage')}
            disabled={older === undefined} onClick={older === undefined ? undefined : () => { setSelectedMessage(older.id) }}>
            <IconChevronLeftOutline14 />
          </Button>
          <span className="dsw-settings-cell-desc">{index + 1} / {messages.length}</span>
          <Button size="touch" aria-label={t('newerMessage')} title={t('newerMessage')}
            disabled={newer === undefined} onClick={newer === undefined ? undefined : () => { setSelectedMessage(newer.id) }}>
            <IconChevronRightOutline14 />
          </Button>
        </PanelActions>
        <MessageBody>{message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')}</MessageBody>
        {message.content.some(block => block.type !== 'text') && <p>{t('messageAttachments')}</p>}
      </PanelEntry>}
    </div>
  </PanelSection>
}
