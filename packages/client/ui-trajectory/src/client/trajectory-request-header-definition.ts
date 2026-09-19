import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, ConversationPromptSnapshot, ConversationPromptSnapshotReader,
  RequestPromptInspector,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { trajectoryNode } from './trajectory-definition-common.ts'
import type { TrajectoryRequestHeaderState } from './trajectory-contract.ts'

function previousRequestHeaderPrompt(
  value: unknown,
  readPrompt: ConversationPromptSnapshotReader,
): ConversationPromptSnapshot | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('trajectory-request-header predecessor State is not an object')
  }
  return readPrompt(Reflect.get(value, 'prompt'))
}

/**
 * Request-header fact Definition for the Trajectory target.
 * @param inspect - request-header prompt interpretation.
 * @param readPrompt - claim a stored prompt snapshot.
 * @returns the Trajectory request-header Definition.
 */
function trajectoryRequestHeaderDefinition(
  inspect: RequestPromptInspector,
  readPrompt: ConversationPromptSnapshotReader,
): ConversationNodeDefinition<TrajectoryRequestHeaderState> {
  return {
    kind: 'trajectory-request-header',
    target: 'trajectory',
    match: event => event.type === 'request/header'
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (_context, match, reader) => {
      if (match.event.type !== 'request/header') {
        throw new Error('trajectory-request-header start requires request/header')
      }
      const previous = previousRequestHeaderPrompt(reader.previous('trajectory-request-header')?.state, readPrompt)
      const { prompt, change } = inspect(previous, match.event)
      return {
        seq: match.event.seq,
        time: match.event.time,
        prompt,
        location: match.location,
        ...(change === undefined ? {} : { change }),
      }
    },
    update: context => context.state,
    buildViewNode: context => context.state === undefined
      ? null
      : trajectoryNode(context, context.state.seq, {
        kind: 'request-header',
        header: context.state,
      }),
  }
}

/**
 * Register Trajectory request-header facts.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
export function registerTrajectoryRequestHeaderDefinition(ctx: Context): void {
  ctx.uiConversation.events.register(trajectoryRequestHeaderDefinition(
    (previous, event) => ctx.uiConversation.inspectRequestPrompt(previous, event),
    value => ctx.uiConversation.requireConversationPromptSnapshot(value),
  ))
}
