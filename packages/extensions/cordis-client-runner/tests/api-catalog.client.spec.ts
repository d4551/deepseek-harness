import { describe, expect, it } from 'vitest'
import { EVENT_API, queryServiceApi, SERVICE_API } from '../src/client/api-catalog.ts'

describe('Client Cordis inspect catalog', () => {
  it('publishes the browser timer overloads and their lifecycle contracts', () => {
    const timers = SERVICE_API.filter(service => service.key === 'timer')
    expect(timers).toHaveLength(1)
    expect(timers[0]?.methods.map(method => method.signature)).toEqual([
      'timeout(callback: () => void, delay: number): TimerDisposer',
      'timeout(delay: number): Promise<void>',
      'interval(callback: () => void, delay: number): TimerDisposer',
      'interval<R = unknown>(delay: number): AsyncIterableIterator<void, R, void>',
      'throttle<Args extends unknown[]>(callback: (...args: Args) => void, delay: number, noTrailing?: boolean): Scheduled<Args>',
      'debounce<Args extends unknown[]>(callback: (...args: Args) => void, delay: number): Scheduled<Args>',
    ])
    expect(timers[0]?.description).toBe('Browser timer Service whose pending work belongs to the calling Fiber.')
    expect(timers[0]?.methods[3]).toEqual({
      signature: 'interval<R = unknown>(delay: number): AsyncIterableIterator<void, R, void>',
      description: 'Iterate over timer ticks.',
      parameters: [{ name: 'delay', description: 'interval in milliseconds.' }],
      returns: "async iterator of ticks. Its `throw()` keeps an Error's identity;"
        + ' an omitted reason becomes an Error, and other values become a TypeError with the original cause.'
        + ' Disposing the calling Fiber rejects pending and subsequent `next()` calls.',
    })
  })

  it('includes both timer result types in the inspected coding contract', () => {
    expect(queryServiceApi('timer')).toMatchObject({
      mode: 'service',
      referencedTypes: [
        {
          name: 'Scheduled',
          declaration: 'export type Scheduled<Args extends unknown[]> = ((...args: Args) => void) & {\n'
            + '    dispose: TimerDisposer;\n};',
        },
        { name: 'TimerDisposer', declaration: 'export type TimerDisposer = () => void | Promise<void>;' },
      ],
    })
  })

  it('publishes the split Workspace Controller and UI navigation services', () => {
    expect(SERVICE_API.find(service => service.key === 'workspaces')?.methods.map(method => method.signature))
      .toEqual([
        'create(input: { path: string }): Promise<WorkspaceView>',
        'rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>',
        'delete(workspaceId: WorkspaceId): Promise<void>',
        'archiveSession(sessionId: SessionId): Promise<void>',
        'insertSessionBefore( workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId, ): Promise<WorkspaceView>',
      ])
    expect(SERVICE_API.find(service => service.key === 'uiWorkspace')?.methods.map(method => method.signature))
      .toEqual([
        'connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>',
        'startSession(workspaceId?: WorkspaceId): void',
        'archiveSession(sessionId: SessionId): Promise<void>',
        'pickDirectory(): Promise<string | null>',
        'listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>',
        'createDirectory(path: string, name: string): Promise<string>',
      ])
  })

  it('contains one entry per visible Client event', () => {
    const names = EVENT_API.map(event => event.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('includes the current referenced type closure for the Sessions service', () => {
    const result = queryServiceApi('sessions') as {
      referencedTypes: readonly { name: string }[]
    }
    expect(result.referencedTypes.length).toBeGreaterThan(0)
    expect(result.referencedTypes.map(type => type.name)).not.toEqual(expect.arrayContaining([
      'ConversationSnapshot',
      'PendingInteraction',
      'PendingPayloads',
      'PendingWait',
    ]))
  })
})
