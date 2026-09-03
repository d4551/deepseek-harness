/**
 * Configuration schema and the one explicit resolve step for the LiteRT-LM
 * route. Resolution decides which of the two first-class postures a
 * composition asked for — an already-running server named by `baseURL`, or a
 * locally supervised `litert-lm serve` process — and produces the endpoint the
 * pi-ai `openai-completions` route is registered against.
 *
 * @module dsh-llm-litert/config
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Path segment `litert-lm serve` appends to its host and port for the OpenAI-compatible API. */
const OPENAI_API_PREFIX = '/v1'

/** One model this route serves, addressed by its `litert-lm` registry id. */
export interface LitertModelConfig {
  /**
   * The `litert-lm` registry id (`MODEL_ID`). It is also the `model` field the
   * server answers to on `POST /v1/chat/completions`, so it is the name the
   * harness route exposes.
   */
  id: string
  /**
   * The `.litertlm` file `litert-lm import` reads: a local path when the model
   * is already on disk, or the file name inside {@link huggingFaceRepo} when
   * it must be downloaded. Required by the supervised posture, which runs that
   * import; refused by the remote posture, which imports nothing.
   */
  file?: string
  /**
   * Hugging Face repository the file is pulled from when the registry does not
   * already hold {@link id}. Omit it for a purely local `.litertlm` file, and
   * in the remote posture, which refuses it.
   */
  huggingFaceRepo?: string
  /** Context capacity of this model, in tokens. */
  contextWindow: number
  /** Largest completion this model can produce, in tokens. */
  maxTokens: number
}

/** Supervision settings for a locally launched `litert-lm serve` process. */
export interface LitertServerConfig {
  /** `litert-lm` executable, resolved through the subprocess seam's execution world. */
  command?: string
  /** Address passed to `litert-lm serve --host`; also the address the harness connects to. */
  host?: string
  /** Port passed to `litert-lm serve --port`. */
  port?: number
  /**
   * Working directory for the `litert-lm` child processes. It is also what
   * selects local supervision: schemastery materializes an absent `server`
   * object with every default filled, so the one field that can have no
   * sensible default is what tells a resolved configuration apart from an
   * unset one.
   */
  cwd?: string
  /** Environment entries merged onto the subprocess provider's scrubbed parent environment. */
  env?: Record<string, string>
  /** Budget for the server to answer `GET /v1/models` after it is spawned. */
  startupTimeoutMs?: number
  /** Interval between `GET /v1/models` attempts while waiting for startup. */
  healthIntervalMs?: number
  /** SIGTERM-to-SIGKILL window applied to every `litert-lm` child this plugin owns. */
  shutdownGraceMs?: number
  /** Budget for one `litert-lm import`, which downloads models of 0.5-4.2 GB. */
  importTimeoutMs?: number
  /**
   * Stdout tail retained per `litert-lm` child. `litert-lm list` output is
   * parsed from it to decide which models the registry still needs, so a bound
   * that cannot hold one registry listing loses the ids that slid out of the
   * tail and re-imports models the registry already holds — gigabytes per lost
   * id. Size it for the largest listing this route can see, never for log
   * volume; {@link maxStderrBytes} is the knob for that.
   */
  maxStdoutBytes?: number
  /** Diagnostic stderr tail retained per `litert-lm` child and quoted in failures. */
  maxStderrBytes?: number
}

/** Plugin configuration: one LiteRT-LM route and the server that serves it. */
export interface Config {
  /** Harness route key this plugin registers on `ctx.llm`. */
  provider: string
  /** Name configuration surfaces show for the route; defaults to {@link provider}. */
  displayName?: string
  /** Models the route serves; every entry must be importable into the registry. */
  models: LitertModelConfig[]
  /**
   * Endpoint of an already-running LiteRT-LM server, including its `/v1`
   * prefix. Setting it selects the remote posture: no process is supervised
   * and {@link LitertServerConfig.cwd} must be absent.
   */
  baseURL?: string
  /**
   * Supervision settings for a local `litert-lm serve`. Setting its `cwd`
   * selects the local posture: models are imported, the server is started and
   * health-waited at load, and it is terminated on dispose.
   */
  server?: LitertServerConfig
}

/** A {@link LitertServerConfig} after every schema default has been applied. */
export type ResolvedLitertServerConfig = Required<LitertServerConfig>

/** The endpoint posture resolution selected, and the local supervision it entails. */
export type ResolvedLitertEndpoint =
  | {
    /** An already-running server; nothing is spawned or imported. */
    readonly kind: 'remote'
    /** Endpoint the pi-ai route is registered against. */
    readonly baseURL: string
  }
  | {
    /** A `litert-lm serve` process this plugin owns for its whole lifetime. */
    readonly kind: 'local'
    /** Endpoint the pi-ai route is registered against, derived from host and port. */
    readonly baseURL: string
    /** Fully defaulted supervision settings. */
    readonly server: ResolvedLitertServerConfig
    /** Imports that must reach the registry before the server starts, in configuration order. */
    readonly imports: readonly LitertImport[]
  }

/**
 * One `litert-lm import` a supervised route runs before its server starts.
 * Only the supervised posture resolves these: the remote posture refuses the
 * keys they are read from.
 */
export interface LitertImport {
  /** Registry id the model is imported under; also the `model` name the server answers to. */
  readonly id: string
  /** The `.litertlm` file `litert-lm import` reads. */
  readonly file: string
  /** Hugging Face repository the file is pulled from; absent for a file already on disk. */
  readonly huggingFaceRepo?: string
}

/** One validated LiteRT-LM route: its identity, its models, and its endpoint. */
export interface ResolvedLitertConfig {
  /** Harness route key registered on `ctx.llm`. */
  readonly provider: string
  /** Resolved display name for selectors and configuration surfaces. */
  readonly displayName: string
  /** Models the route serves, in configuration order. */
  readonly models: readonly LitertModelConfig[]
  /** Where requests go, and whether a local process backs it. */
  readonly endpoint: ResolvedLitertEndpoint
}

const LitertModelConfigSchema: z<LitertModelConfig> = z.object({
  id: z.string().required(),
  file: z.string(),
  huggingFaceRepo: z.string(),
  contextWindow: z.number().step(1).min(1).required(),
  maxTokens: z.number().step(1).min(1).required(),
})

const LitertServerConfigSchema: z<LitertServerConfig> = z.object({
  command: z.string().default('litert-lm'),
  host: z.string().default('127.0.0.1'),
  port: z.number().step(1).min(1).max(65_535).default(9379),
  cwd: z.string(),
  env: z.dict(z.string()).default({}),
  startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  healthIntervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(500),
  shutdownGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
  importTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(1_800_000),
  maxStdoutBytes: z.number().step(1).min(1).default(1_048_576),
  maxStderrBytes: z.number().step(1).min(1).default(65_536),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  provider: z.string().required(),
  displayName: z.string(),
  models: z.array(LitertModelConfigSchema).required(),
  baseURL: z.string(),
  server: LitertServerConfigSchema,
})

/** Prefix every configuration failure carries, so the offending plugin is named. */
const PREFIX = 'llm-litert'

/** Reject a tunable Node would clamp or a budget that can never elapse. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${PREFIX}: server.${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Reject a retention bound that could hold no output at all. */
function assertByteBound(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${PREFIX}: server.${name} must be a positive integer`)
  }
}

/**
 * Render one host as a URL authority. An IPv6 literal must be bracketed or the
 * colons in it are read as the port separator.
 * @param host - configured bind address.
 * @param port - configured port.
 * @returns the `host:port` authority for the endpoint URL.
 */
function authority(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

/** Reject a `baseURL` the pi-ai route could not send a request to. */
function assertUsableBaseURL(baseURL: string): void {
  if (baseURL.length === 0) throw new Error(`${PREFIX}: baseURL must not be empty`)
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch (error) {
    throw new Error(`${PREFIX}: baseURL ${JSON.stringify(baseURL)} is not an absolute URL`, { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${PREFIX}: baseURL ${JSON.stringify(baseURL)} must use http or https`)
  }
}

/** The keys that instruct `litert-lm import`; only a supervised route can act on either. */
const IMPORT_KEYS = ['file', 'huggingFaceRepo'] as const

/** Reject a model list no posture could serve. */
function assertModels(models: readonly LitertModelConfig[]): void {
  if (models.length === 0) {
    throw new Error(`${PREFIX}: models must list at least one model`)
  }
  const seen = new Set<string>()
  for (const model of models) {
    if (model.id.length === 0) throw new Error(`${PREFIX}: a model has an empty id`)
    if (seen.has(model.id)) throw new Error(`${PREFIX}: model ${JSON.stringify(model.id)} is listed more than once`)
    seen.add(model.id)
    for (const key of IMPORT_KEYS) {
      if (model[key]?.length === 0) {
        throw new Error(`${PREFIX}: model ${JSON.stringify(model.id)} has an empty ${key}`)
      }
    }
  }
}

/**
 * Reject an import instruction on a route that imports nothing. The remote
 * posture never touches the registry the named server reads, so both keys
 * would read as promises this plugin cannot keep.
 */
function assertNoImports(models: readonly LitertModelConfig[]): void {
  for (const model of models) {
    for (const key of IMPORT_KEYS) {
      if (model[key] !== undefined) {
        throw new Error(
          `${PREFIX}: model ${JSON.stringify(model.id)} names ${key}, but this route points at an`
          + ' already-running server through baseURL and imports nothing; import the model where that server runs',
        )
      }
    }
  }
}

/**
 * Read the import every supervised model needs. `file` is what
 * `litert-lm import` reads, so this posture is where its absence is a failure.
 * @param models - the configured models of a supervised route.
 * @returns one import instruction per model, in configuration order.
 * @throws Error naming a model that gives the importer nothing to read.
 */
function resolveImports(models: readonly LitertModelConfig[]): readonly LitertImport[] {
  return models.map((model) => {
    if (model.file === undefined) {
      throw new Error(
        `${PREFIX}: model ${JSON.stringify(model.id)} must name the .litertlm file litert-lm import reads,`
        + ' because this route supervises its own server and imports the model itself',
      )
    }
    return {
      id: model.id,
      file: model.file,
      ...model.huggingFaceRepo === undefined ? {} : { huggingFaceRepo: model.huggingFaceRepo },
    }
  })
}

/**
 * Validate one plugin configuration and decide its endpoint posture. This is
 * the package's only defaulting step: everything downstream reads a resolved
 * value, and every rejection names the configuration key that caused it.
 * @param config - the plugin configuration; schemastery has applied every default.
 * @returns the validated route with its endpoint resolved.
 * @throws Error naming the configuration key that cannot be served.
 */
export function resolveConfig(config: Config): ResolvedLitertConfig {
  if (config.provider.length === 0) throw new Error(`${PREFIX}: provider must be a non-empty route key`)
  if (config.displayName !== undefined && config.displayName.length === 0) {
    throw new Error(`${PREFIX}: displayName must not be empty`)
  }
  const supervises = config.server?.cwd !== undefined
  if (config.baseURL !== undefined && supervises) {
    throw new Error(
      `${PREFIX}: baseURL and server.cwd are the two postures of one route; set baseURL for an`
      + ' already-running server, or server.cwd to supervise a local litert-lm serve, never both',
    )
  }
  if (config.baseURL === undefined && !supervises) {
    throw new Error(
      `${PREFIX}: a route must either name an already-running server with baseURL or supervise a local one`
      + ' with server.cwd',
    )
  }
  assertModels(config.models)
  const displayName = config.displayName ?? config.provider
  if (config.baseURL !== undefined) {
    assertNoImports(config.models)
    assertUsableBaseURL(config.baseURL)
    return {
      provider: config.provider,
      displayName,
      models: [...config.models],
      endpoint: { kind: 'remote', baseURL: config.baseURL },
    }
  }
  // schemastery filled every optional server field, and `cwd` decided the
  // posture above; the assertions below cover what its numeric ranges cannot
  // express.
  const server = config.server as ResolvedLitertServerConfig
  if (server.command.length === 0) throw new Error(`${PREFIX}: server.command must not be empty`)
  if (server.host.length === 0) throw new Error(`${PREFIX}: server.host must not be empty`)
  if (server.cwd.length === 0) throw new Error(`${PREFIX}: server.cwd must not be empty`)
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65_535) {
    throw new Error(`${PREFIX}: server.port must be an integer from 1 through 65535`)
  }
  assertTimer('startupTimeoutMs', server.startupTimeoutMs)
  assertTimer('healthIntervalMs', server.healthIntervalMs)
  assertTimer('shutdownGraceMs', server.shutdownGraceMs)
  assertTimer('importTimeoutMs', server.importTimeoutMs)
  assertByteBound('maxStdoutBytes', server.maxStdoutBytes)
  assertByteBound('maxStderrBytes', server.maxStderrBytes)
  if (server.healthIntervalMs > server.startupTimeoutMs) {
    throw new Error(
      `${PREFIX}: server.healthIntervalMs (${server.healthIntervalMs}) must not exceed`
      + ` server.startupTimeoutMs (${server.startupTimeoutMs}), or startup gives up before its first probe`,
    )
  }
  return {
    provider: config.provider,
    displayName,
    models: [...config.models],
    endpoint: {
      kind: 'local',
      baseURL: `http://${authority(server.host, server.port)}${OPENAI_API_PREFIX}`,
      server: { ...server, env: { ...server.env } },
      imports: resolveImports(config.models),
    },
  }
}
