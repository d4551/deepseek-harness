/** First-party Host inspect providers registered by the Cordis tool package. */

import type { Context } from '@deepseek-ai/cordis'
import { HOST_BUILTIN_INSPECTION } from '@deepseek-ai/dsh-cordis-host-runner'
import type { HostCordisInspectProviderRegistration } from '@deepseek-ai/dsh-cordis-host-runner'
import {
  ANY_OUTPUT, EMPTY_INPUT, EVENT_INPUT, EVENT_OUTPUT, SERVICE_INPUT, SERVICE_OUTPUT,
  inspectProvider, readExact,
} from '@deepseek-ai/dsh-cordis-host-runner/wire-values'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { EVENT_API, queryEventApi, queryServiceApi } from './api-catalog.ts'

const HOST_EVENTS = EVENT_API.filter(event => !event.name.startsWith('cordis/'))

/**
 * Construct Host providers over generated Catalogs, evaluator declarations, and live Tool scope.
 * @param ctx - Host context used for Agent-scoped live Tool queries.
 * @returns registrations for static catalogs and live Host capabilities.
 */
export function hostInspectProviders(ctx: Context): HostCordisInspectProviderRegistration[] {
  return [
    inspectProvider(
      'Service',
      'Progressive Host Service discovery: compact capability/signature directory, then one exact coding contract.',
      'listService',
      input => queryServiceApi(readExact(input, 'service')) as unknown as JsonValue,
      SERVICE_INPUT,
      SERVICE_OUTPUT,
    ),
    inspectProvider(
      'Event',
      'Progressive Host Event discovery: compact listener directory, then one exact event contract.',
      'listEvents',
      input => queryEventApi(readExact(input, 'event'), HOST_EVENTS) as unknown as JsonValue,
      EVENT_INPUT,
      EVENT_OUTPUT,
    ),
    inspectProvider('Builtin', 'Plain-JavaScript symbols available to a dynamic Host half.', 'listBuiltins', () => ({
      builtins: HOST_BUILTIN_INSPECTION,
      referencedTypes: [],
    } as unknown as JsonValue)),
    {
      manifest: {
        id: 'Tool',
        description: 'Tools visible to the requesting Agent, including scoped and dynamic registrations.',
        methods: [{
          name: 'listTools',
          description: 'Return every Tool schema currently callable by this Agent.',
          inputSchema: EMPTY_INPUT,
          outputSchema: ANY_OUTPUT,
        }],
      },
      query(method, _input, context) {
        if (method !== 'listTools') throw new Error(`unknown Tool inspect method "${method}"`)
        return Promise.resolve({ tools: ctx.tools.schemas(context.agent) } as unknown as JsonValue)
      },
    },
  ]
}
