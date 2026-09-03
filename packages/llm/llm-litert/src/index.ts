/**
 * LiteRT-LM route plugin. It owns the two things an OpenAI-compatible client
 * cannot do for LiteRT-LM — importing `.litertlm` models into the `litert-lm`
 * registry, and supervising the `litert-lm serve` process — and then delegates
 * every request to the pi-ai `openai-completions` adapter by registering the
 * resolved endpoint and model catalog as a pi-ai provider profile. No HTTP
 * client, streaming decoder, or message conversion lives in this package.
 *
 * Both endpoint postures are first class. A route naming `baseURL` points at
 * an already-running server (a Railway deployment, a server started outside
 * the harness) and supervises no process at all. A route carrying `server`
 * imports its models, starts `litert-lm serve` through `ctx.subprocess`, waits
 * for `GET /v1/models`, and terminates the process on dispose.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-litert'
 *   config:
 *     provider: litert
 *     models:
 *       - id: gemma4-e2b
 *         file: gemma-4-E2B-it.litertlm
 *         huggingFaceRepo: litert-community/gemma-4-E2B-it-litert-lm
 *         contextWindow: 32768
 *         maxTokens: 4096
 *     server:
 *       cwd: /var/lib/litert
 *       port: 9379
 *       importTimeoutMs: 1800000
 * ```
 *
 * @module @deepseek-ai/dsh-llm-litert
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { authContextFrom, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai/auth'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/config'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai/config'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedLitertConfig } from './config.ts'
import { httpHealthProbe, LitertServer } from './server.ts'
import type { LitertHealthProbe } from './server.ts'

export { Config, resolveConfig } from './config.ts'
export type {
  LitertImport,
  LitertModelConfig,
  LitertServerConfig,
  ResolvedLitertConfig,
  ResolvedLitertEndpoint,
  ResolvedLitertServerConfig,
} from './config.ts'
export { httpHealthProbe, LITERT_TIMEOUT_CODE, LitertServer } from './server.ts'
export type {
  LitertExecutableResolver,
  LitertHealthProbe,
  LitertServerCollaborators,
  LitertServerSpec,
  LitertSpawner,
} from './server.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-litert'

/** The LLM seam this route registers into, and the seam its server process runs on. */
export const inject = ['llm', 'subprocess']

/** The wire protocol `litert-lm serve` speaks; pi-ai owns its implementation. */
const OPENAI_COMPLETIONS_API = 'openai-completions'

/**
 * Credential presented on every request. LiteRT-LM's server authenticates
 * nothing, but pi-ai's OpenAI-completions client refuses to build a request
 * without a key or an `Authorization` header of its own, so a fixed
 * non-secret placeholder rides in the header and the server ignores it. This
 * is a protocol constant of that client, not a deployment choice: a LiteRT-LM
 * endpoint that did check credentials would not be this plugin's route.
 */
const UNAUTHENTICATED_API_KEY = 'unused'

/**
 * Build the pi-ai provider profile for one resolved route. Every request fact —
 * protocol, endpoint, model catalog — is decided here and nowhere else, so the
 * delegate adapter serves LiteRT-LM exactly as it serves any hand-declared
 * OpenAI-compatible gateway.
 * @param resolved - the validated route.
 * @returns the profile keyed by the harness route key.
 */
function providerProfile(resolved: ResolvedLitertConfig): Record<string, PiAiProviderProfile> {
  return {
    [resolved.provider]: {
      displayName: resolved.displayName,
      api: OPENAI_COMPLETIONS_API,
      baseURL: resolved.endpoint.baseURL,
      models: resolved.models.map(model => ({
        id: model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    },
  }
}

/**
 * Start the supervised server, cancelling the startup work if the plugin is
 * unloaded while it runs, and register its teardown as an effect.
 * @param ctx - the plugin context carrying `ctx.subprocess`.
 * @param resolved - the validated route in its local posture.
 * @param probe - the readiness probe; tests inject a fake here.
 */
async function superviseServer(
  ctx: Context,
  resolved: ResolvedLitertConfig & { endpoint: { kind: 'local' } },
  probe: LitertHealthProbe,
): Promise<void> {
  const server = new LitertServer(
    { server: resolved.endpoint.server, baseURL: resolved.endpoint.baseURL, imports: resolved.endpoint.imports },
    {
      resolveExecutable: (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal),
      spawn: spec => ctx.subprocess.spawn(spec),
      probe,
    },
  )
  const setupAbort = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    // An async plugin callback must observe its own disposal before Cordis can
    // run effect cleanup, because unload otherwise waits for this callback.
    if (fiber === ctx.fiber && fiber.uid === null) {
      setupAbort.abort(new Error('llm-litert setup disposed'))
    }
  })
  try {
    await server.start(setupAbort.signal)
  } catch (error) {
    // Nothing registered the teardown effect yet, so a failed start owns the
    // process it may have spawned.
    await server.dispose()
    throw error
  } finally {
    stopSetupCancellation()
  }
  ctx.effect(() => () => server.dispose(), 'llm-litert: litert-lm serve')
}

/**
 * Register one LiteRT-LM route: bring its endpoint up when this composition
 * owns the server, then register the pi-ai adapter that speaks to it.
 * @param ctx - plugin context carrying the `llm` and `subprocess` seams.
 * @param config - validated plugin config; schemastery has applied every default.
 * @param probe - readiness probe used while waiting for a supervised server; tests inject a fake here.
 */
export async function apply(
  ctx: Context,
  config: Config,
  probe: LitertHealthProbe = httpHealthProbe,
): Promise<void> {
  const resolved = resolveConfig(config)
  // Resolution happens before the server starts: an unserviceable model list
  // must not cost a multi-gigabyte import first.
  const profiles = resolveProfiles(providerProfile(resolved))
  if (resolved.endpoint.kind === 'local') {
    await superviseServer(ctx, { ...resolved, endpoint: resolved.endpoint }, probe)
  }
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve(UNAUTHENTICATED_API_KEY),
    // Read through `ctx` per call so a credential the harness stores for
    // another pi-ai route cannot be captured here at construction; this route
    // itself authenticates nothing.
    auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
  })
  // The registry binds this to the calling fiber, so disposal removes the
  // route before the server-teardown effect above stops the process.
  ctx.llm.registerAdapter([resolved.provider], adapter)
}
