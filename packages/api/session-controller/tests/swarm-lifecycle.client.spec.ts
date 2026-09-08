import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, fakeRemote, remoteOk } from './fake-api.client.ts'

it.each<{ mode: 'one-shot' | 'continuable' }>([{ mode: 'one-shot' }, { mode: 'continuable' }])(
  'keeps an unselected $mode conversation readable when its worker stops', async ({ mode }) => {
    const parent = SessionId('worker-parent')
    const child = SessionId('worker-child')
    const api = new FakeApiClient()
    api.onSubagentList = id => Promise.resolve(remoteOk({
      entries: id === parent ? [{
        kind: 'child', id: child, mode, label: 'worker',
        activity: 'running', hasChildren: false,
      }] : [],
      parentAvailable: true,
    }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshSubagents(parent)
    const conversation = manager.get(child)
    manager.handleSessionRemoved(child)
    manager.selectSubagent({ parentSessionId: parent, childSessionId: child, mode })

    expect(manager.get(child)).toBe(conversation)
    expect(conversation.getSnapshot()).toMatchObject({ removed: false, running: false, blank: false })
    expect(manager.getListSnapshot().subagentsByParent[parent]?.entries).toMatchObject([
      { id: child, kind: 'child', activity: 'inactive' },
    ])
    await conversation.open()
    expect(api.callsOf('session.follow')).toEqual([{
      address: { kind: 'subagent', parentSessionId: parent, childSessionId: child, mode },
      maxMessages: 50,
    }])
    await manager.dispose()
  },
)
