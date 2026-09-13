import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamMemberView } from '@deepseek-ai/dsh-agent-team/client'
import { Button, PanelSection, PanelTable, PanelActions, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'
import { memberLabel } from './member-label.ts'

interface TeamMembersProps {
  members: readonly TeamMemberView[]
  sessionId: SessionId
  t: (key: TeamKey) => string
  open: (member: TeamMemberView) => Promise<void>
  reportError: (reason: unknown) => void
}

function memberStatusKey(status: TeamMemberView['status']): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'waiting': return 'memberStatus.waiting'
    case 'idle': return 'memberStatus.idle'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

/** Separate this team's roster from independent conversations in its workspace. */
export function TeamMembers(props: TeamMembersProps) {
  const teammates = props.members.filter(member => member.role !== 'peer')
  const peers = props.members.filter(member => member.role === 'peer')
  return <>
    <MemberTable {...props} members={teammates} title={props.t('roster')} />
    {peers.length > 0 && <MemberTable {...props} members={peers} title={props.t('workspacePeers')} />}
  </>
}

function MemberTable({ members, sessionId, t, open, reportError, title }: TeamMembersProps & { title: string }) {
  return <PanelSection title={title} actions={<Pill>{members.length}</Pill>}>
    <PanelTable label={title} columns={[t('member'), t('activity'), t('model')]}>
      {members.map(member => <tr key={member.id}>
        <th scope="row">
          {member.id !== sessionId && member.status !== 'failed' && member.status !== 'provisioning'
            ? <Button size="sm" aria-label={`${t('open')}: ${memberLabel(member, t)}`}
              onClick={() => { open(member).then(undefined, reportError) }}>{memberLabel(member, t)}</Button>
            : <span title={member.name}>{memberLabel(member, t)}</span>}
          {member.description !== undefined && <p className="dsw-settings-cell-desc">{member.description}</p>}
          {member.diagnostics.map(diagnostic => <p key={diagnostic} role="alert">{diagnostic}</p>)}
        </th>
        <td><PanelActions>
          <StateDot state={member.status === 'running' ? 'ongoing' : member.status === 'failed' ? 'error' : 'inactive'} />
          <span>{t(memberStatusKey(member.status))}</span>
        </PanelActions></td>
        <td>{member.model ?? t('modelUnavailable')}</td>
      </tr>)}
    </PanelTable>
  </PanelSection>
}
