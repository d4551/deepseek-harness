/**
 * Workspace-root panel, browser half: occupies a conversation session-header
 * seat with the folders the session works in. Reads ride the generic
 * projection pair (`workspaceRoots`) through the standard-kit `useProjection`,
 * so this plugin owns no root state; writes go to the Session Remote, and the
 * host's resulting `workspace/roots` event is what changes the rendered set.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the `workspaceRoots` SessionProjectionMap merge.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the ctx.uiWorkspace merge that owns the directory chooser.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspaceRootsAction, type WorkspaceRootsInjected } from './WorkspaceRootsAction.tsx'
import { en, NS, zh, type WorkspaceRootsKey } from './locales.ts'

export type { WorkspaceRootsInjected, WorkspaceRootsActionProps } from './WorkspaceRootsAction.tsx'
export type { WorkspaceRootsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace-root panel copy. */
    'workspace-roots': WorkspaceRootsKey
  }
}

/**
 * Required browser services: the session Remote namespace that reads and
 * replaces roots, the workspace capability that owns the directory chooser,
 * the header's slot registry, and the locale registry.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'uiWorkspace']

/**
 * Client plugin body: register the workspace-root header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace-roots: dictionaries')

  const actions: WorkspaceRootsInjected = {
    setRoots: (sessionId: SessionId, additionalDirectories) =>
      ctx.remote.session.setWorkspaceRoots({ sessionId, additionalDirectories: [...additionalDirectories] }),
    pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
    loadOrigin: () => ctx.remote.session.workspaceOrigin(),
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'workspace-roots',
      order: 15,
      locale: NS,
      inject: () => actions,
    }, WorkspaceRootsAction),
  )
}
