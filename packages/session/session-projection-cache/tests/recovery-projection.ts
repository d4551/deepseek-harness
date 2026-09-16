import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'recovery/turns': number }
  interface SessionProjectionMap { 'recovery/turns': number }
}

export const recoveryProjection = {
  key: 'recovery/turns', stateSchema: z.number().int().nonnegative(), stateVersion: 1,
  init: () => 0,
  apply: (state, event) => event.type === 'turn/start' ? state + 1 : state,
  wire: { viewSchema: z.number().int().nonnegative(), view: state => state },
} satisfies ProjectionDefinition<'recovery/turns', number>
