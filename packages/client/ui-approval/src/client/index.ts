/** Browser approval consumer over the existing scoped Remote Event waterfall. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  settlePendingInteraction, type PendingInteractionPublisher,
} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ApprovalPanel } from './ApprovalPanel.tsx'
import { PendingApproval } from './contract/slots.ts'
import { en, zh } from './locales.ts'

export type {
  ApprovalComposerProps,
  ApprovalDecision,
  ApprovalDetailOwnerProps,
  ApprovalPresentationRequest,
  PendingApproval,
} from './contract/slots.ts'
export type { ApprovalKey } from './locales.ts'

/** Required services: Agent scopes, Remote Events, Session UI, Slot registry, and copy. */
export const inject = ['sessions', 'remote', 'uiSession', 'slots', 'locale']

const NS = 'approval'

type ApprovalListener = TypertClientEventListener<'approval/request'>
type ClientApprovalRequest = Parameters<ApprovalListener>[0]
type ClientApprovalNext = Parameters<ApprovalListener>[1]
type ClientApprovalOutcome = Awaited<ReturnType<ApprovalListener>>

/** Present one request until the user answers or its lifetime ends. */
function answerApproval(
  ctx: ClientContext,
  owner: ClientContext,
  request: ClientApprovalRequest,
  next: ClientApprovalNext,
  registerPendingInteraction: PendingInteractionPublisher<PendingApproval>,
): Promise<ClientApprovalOutcome> {
  const sessionId = ctx.sessions.scopeOf(owner)
  if (sessionId === undefined) return next()
  const pending = new PendingApproval(sessionId, {
    toolName: request.toolName,
    ...(request.callId === undefined
      ? {}
      : { callId: request.callId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  return settlePendingInteraction(pending, registerPendingInteraction, next)
}

/**
 * Install approval copy and the scoped waterfall consumer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-approval: dictionaries')
  const registerPendingInteraction = ctx.uiSession.registerPendingInteraction<PendingApproval>(
    () => 0,
  )
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: 1,
    select: ({ pendingInteraction }: ComposerChainProps): PendingApproval | null =>
      pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
    locale: NS,
    children: {
      'conversation.approval.detail': { kind: 'single', scope: 'session' },
    },
  }, ApprovalPanel))
  ctx.remote.$on('approval/request', function (request, next) {
    return answerApproval(ctx, this, request, next, registerPendingInteraction)
  })
}
