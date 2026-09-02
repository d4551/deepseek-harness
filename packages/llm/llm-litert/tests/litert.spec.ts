import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { resolveConfig } from '../src/config.ts'
import type { Config, LitertModelConfig, ResolvedLitertServerConfig } from '../src/config.ts'
import { LitertServer } from '../src/server.ts'
import type { LitertHealthProbe, LitertServerSpec } from '../src/server.ts'
import * as litert from '../src/index.ts'

/** What the fake `litert-lm` does for one spawned subcommand. */
interface ScriptedRun {
  /** Retained stdout tail the run reports. */
  stdout?: string
  /** Retained stderr tail the run reports. */
  stderr?: string
  /** Exit code; ignored when `lingers` is set and the run is terminated. */
  exitCode?: number
  /** Keep running until terminated or until the spawn spec's signal aborts. */
  lingers?: boolean
}

/** One spawned fake child, recording the termination the caller drove. */
class FakeHandle implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  terminateCount = 0
  private settle: (outcome: SubprocessOutcome) => void = () => {}

  constructor(readonly pid: number, spec: SubprocessSpawnSpec, run: ScriptedRun) {
    const text = (value: string | undefined): { readFrom: () => { text: string; nextOffset: number; lossy: boolean } } => ({
      readFrom: () => ({ text: value ?? '', nextOffset: (value ?? '').length, lossy: false }),
    })
    this.collected = { stdout: text(run.stdout), stderr: text(run.stderr) }
    if (run.lingers !== true) {
      this.done = Promise.resolve({ exitCode: run.exitCode ?? 0, signal: null })
      return
    }
    this.done = new Promise<SubprocessOutcome>((resolve) => {
      this.settle = resolve
    })
    spec.signal?.addEventListener('abort', () => { this.stop() }, { once: true })
  }

  /** Settle the lingering run as a SIGTERM exit, as the seam's escalation would. */
  private stop(): void {
    this.settle({ exitCode: null, signal: 'SIGTERM' })
  }

  terminate(): void {
    this.terminateCount += 1
    this.stop()
  }

  async waitForExit(): Promise<boolean> {
    await this.done
    return true
  }
}

/** Records every `litert-lm` spawn and answers each subcommand from a script. */
class FakeLitert {
  readonly spawns: SubprocessSpawnSpec[] = []
  readonly handles: FakeHandle[] = []

  constructor(private readonly script: Readonly<Record<string, ScriptedRun>>) {}

  /** Subcommand-keyed spawn used by both the unit and the plugin suites. */
  readonly spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    this.spawns.push(spec)
    const subcommand = spec.argv[1] ?? ''
    const handle = new FakeHandle(1000 + this.spawns.length, spec, this.script[subcommand] ?? {})
    this.handles.push(handle)
    return handle
  }

  /** Subcommands spawned so far, in order. */
  subcommands(): string[] {
    return this.spawns.map(spec => spec.argv[1] ?? '')
  }

  /** The complete argv of the first spawn of one subcommand. */
  argvOf(subcommand: string): readonly string[] | undefined {
    return this.spawns.find(spec => spec.argv[1] === subcommand)?.argv
  }
}

/** A probe that answers from a scripted sequence and then keeps its last answer. */
function scriptedProbe(answers: readonly (boolean | Error)[]): { probe: LitertHealthProbe; urls: string[] } {
  const urls: string[] = []
  let index = 0
  const probe: LitertHealthProbe = (url) => {
    urls.push(url)
    const answer = answers[Math.min(index, answers.length - 1)] ?? false
    index += 1
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }
  return { probe, urls }
}

const serverDefaults: ResolvedLitertServerConfig = {
  command: 'litert-lm',
  host: '127.0.0.1',
  port: 9379,
  cwd: '/srv/litert',
  env: {},
  startupTimeoutMs: 2_000,
  healthIntervalMs: 5,
  shutdownGraceMs: 1_000,
  importTimeoutMs: 1_000,
  maxStderrBytes: 4_096,
}

const model: LitertModelConfig = {
  id: 'gemma4-e2b',
  file: 'gemma-4-E2B-it.litertlm',
  huggingFaceRepo: 'litert-community/gemma-4-E2B-it-litert-lm',
  contextWindow: 32_768,
  maxTokens: 4_096,
}

function serverSpec(overrides: Partial<ResolvedLitertServerConfig> = {}): LitertServerSpec {
  return {
    server: { ...serverDefaults, ...overrides },
    baseURL: 'http://127.0.0.1:9379/v1',
    models: [model],
  }
}

/** The same model without an import instruction, as a remote route must declare it. */
function importedElsewhere(): LitertModelConfig {
  const { huggingFaceRepo: _repo, ...rest } = model
  return rest
}

/** Resolve the executable to an absolute path, as the local subprocess provider does. */
const resolveExecutable = (command: string): Promise<string> => Promise.resolve(`/usr/local/bin/${command}`)

describe('LitertServer lifecycle', () => {
  it('imports a missing model, starts serve, health-waits, and terminates on dispose', async () => {
    const litertLm = new FakeLitert({
      list: { stdout: 'ID SIZE MODIFIED\n' },
      import: {},
      serve: { lingers: true },
    })
    const { probe, urls } = scriptedProbe([false, true])
    const server = new LitertServer(serverSpec(), { resolveExecutable, spawn: litertLm.spawn, probe })
    await server.start(new AbortController().signal)
    expect(litertLm.subcommands()).toEqual(['list', 'import', 'serve'])
    expect(litertLm.argvOf('import')).toEqual([
      '/usr/local/bin/litert-lm',
      'import',
      '--from-huggingface-repo',
      'litert-community/gemma-4-E2B-it-litert-lm',
      'gemma-4-E2B-it.litertlm',
      'gemma4-e2b',
    ])
    expect(litertLm.argvOf('serve')).toEqual([
      '/usr/local/bin/litert-lm',
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '9379',
    ])
    expect(urls).toEqual(['http://127.0.0.1:9379/v1/models', 'http://127.0.0.1:9379/v1/models'])
    const serve = litertLm.handles[2]
    expect(serve?.terminateCount).toBe(0)
    await server.dispose()
    expect(serve?.terminateCount).toBe(1)
    // A second dispose has nothing left to terminate.
    await server.dispose()
    expect(serve?.terminateCount).toBe(1)
  })

  it('does not re-import a model the registry already holds', async () => {
    const litertLm = new FakeLitert({
      list: { stdout: 'ID          SIZE   MODIFIED\ngemma4-e2b  1.2 GB 2026-09-01\n' },
      serve: { lingers: true },
    })
    const { probe } = scriptedProbe([true])
    const server = new LitertServer(serverSpec(), { resolveExecutable, spawn: litertLm.spawn, probe })
    await server.start(new AbortController().signal)
    expect(litertLm.subcommands()).toEqual(['list', 'serve'])
    await server.dispose()
  })

  it('imports a purely local .litertlm file without a repository flag', async () => {
    const litertLm = new FakeLitert({ list: {}, import: {}, serve: { lingers: true } })
    const { probe } = scriptedProbe([true])
    const local = importedElsewhere()
    const server = new LitertServer(
      { ...serverSpec(), models: [local] },
      { resolveExecutable, spawn: litertLm.spawn, probe },
    )
    await server.start(new AbortController().signal)
    expect(litertLm.argvOf('import')).toEqual([
      '/usr/local/bin/litert-lm',
      'import',
      'gemma-4-E2B-it.litertlm',
      'gemma4-e2b',
    ])
    await server.dispose()
  })

  it('fails loud when an import fails, naming the model, its source, and the child output', async () => {
    const litertLm = new FakeLitert({
      list: {},
      import: { exitCode: 2, stderr: 'no such revision' },
    })
    const { probe } = scriptedProbe([true])
    const server = new LitertServer(serverSpec(), { resolveExecutable, spawn: litertLm.spawn, probe })
    const source = 'litert-community/gemma-4-E2B-it-litert-lm/gemma-4-E2B-it.litertlm'
    await expect(server.start(new AbortController().signal)).rejects.toThrow(
      `importing model "gemma4-e2b" from ${source} failed with exit code 2: no such revision`,
    )
    expect(litertLm.subcommands()).toEqual(['list', 'import'])
  })

  it('fails loud when the registry cannot be listed', async () => {
    const litertLm = new FakeLitert({ list: { exitCode: 1, stderr: 'registry unreadable' } })
    const { probe } = scriptedProbe([true])
    const server = new LitertServer(serverSpec(), { resolveExecutable, spawn: litertLm.spawn, probe })
    await expect(server.start(new AbortController().signal))
      .rejects.toThrow(/"litert-lm list" failed with exit code 1: registry unreadable/)
  })

  it('fails loud when an import outlives its own timeout', async () => {
    const litertLm = new FakeLitert({ list: {}, import: { lingers: true, stderr: 'downloading' } })
    const { probe } = scriptedProbe([true])
    const server = new LitertServer(
      serverSpec({ importTimeoutMs: 20 }),
      { resolveExecutable, spawn: litertLm.spawn, probe },
    )
    await expect(server.start(new AbortController().signal))
      .rejects.toThrow(/litert-lm import exceeded 20ms: downloading/)
  })

  it('gives up within the configured startup timeout and terminates the unhealthy server', async () => {
    const litertLm = new FakeLitert({ list: { stdout: 'gemma4-e2b\n' }, serve: { lingers: true } })
    const { probe } = scriptedProbe([new Error('ECONNREFUSED')])
    const server = new LitertServer(
      serverSpec({ startupTimeoutMs: 60, healthIntervalMs: 10 }),
      { resolveExecutable, spawn: litertLm.spawn, probe },
    )
    const started = Date.now()
    await expect(server.start(new AbortController().signal)).rejects.toThrow(
      /serve did not answer GET http:\/\/127\.0\.0\.1:9379\/v1\/models within 60ms; last probe failed: ECONNREFUSED/,
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(litertLm.handles[1]?.terminateCount).toBe(1)
  })

  it('fails loud when the serve process exits during startup', async () => {
    const litertLm = new FakeLitert({
      list: { stdout: 'gemma4-e2b\n' },
      serve: { exitCode: 1, stderr: 'address already in use' },
    })
    const { probe } = scriptedProbe([false])
    const server = new LitertServer(
      serverSpec({ startupTimeoutMs: 500, healthIntervalMs: 5 }),
      { resolveExecutable, spawn: litertLm.spawn, probe },
    )
    await expect(server.start(new AbortController().signal))
      .rejects.toThrow(/serve exited during startup with exit code 1: address already in use/)
  })

  it('reports caller cancellation of the startup wait as such', async () => {
    const litertLm = new FakeLitert({ list: { stdout: 'gemma4-e2b\n' }, serve: { lingers: true } })
    const { probe } = scriptedProbe([false])
    const server = new LitertServer(
      serverSpec({ startupTimeoutMs: 10_000, healthIntervalMs: 5 }),
      { resolveExecutable, spawn: litertLm.spawn, probe },
    )
    const controller = new AbortController()
    const pending = server.start(controller.signal)
    const assertion = expect(pending).rejects.toThrow(/serve startup was cancelled/)
    setTimeout(() => { controller.abort(new Error('composition unloaded')) }, 20)
    await assertion
  })

  it('disposes cleanly when nothing was ever spawned', async () => {
    const litertLm = new FakeLitert({})
    const { probe } = scriptedProbe([true])
    const server = new LitertServer(serverSpec(), { resolveExecutable, spawn: litertLm.spawn, probe })
    await expect(server.dispose()).resolves.toBeUndefined()
    expect(litertLm.spawns).toHaveLength(0)
  })
})

describe('resolveConfig', () => {
  // Left unannotated on purpose: `Config` is an interface merged with a
  // schemastery schema constant, and spreading a value typed by the merged
  // name reads as spreading a class instance.
  const base = { provider: 'litert', models: [model] }

  it('derives the local endpoint from the supervised host and port', () => {
    const resolved = resolveConfig({ ...base, server: { ...serverDefaults } })
    expect(resolved.endpoint).toMatchObject({ kind: 'local', baseURL: 'http://127.0.0.1:9379/v1' })
    expect(resolved.displayName).toBe('litert')
  })

  it('brackets an IPv6 bind address in the derived endpoint', () => {
    const resolved = resolveConfig({ ...base, server: { ...serverDefaults, host: '::1', port: 8080 } })
    expect(resolved.endpoint.baseURL).toBe('http://[::1]:8080/v1')
  })

  it('keeps an explicit baseURL and marks the route remote', () => {
    const remoteModel = importedElsewhere()
    const resolved = resolveConfig({
      provider: 'litert',
      displayName: 'LiteRT on Railway',
      models: [remoteModel],
      baseURL: 'https://litert.up.railway.app/v1',
    })
    expect(resolved.endpoint).toEqual({ kind: 'remote', baseURL: 'https://litert.up.railway.app/v1' })
    expect(resolved.displayName).toBe('LiteRT on Railway')
  })

  it('rejects a route that names both postures', () => {
    expect(() => resolveConfig({ ...base, baseURL: 'http://localhost:9379/v1', server: { ...serverDefaults } }))
      .toThrow(/baseURL and server\.cwd are the two postures of one route/)
  })

  it('rejects a route that names neither posture', () => {
    expect(() => resolveConfig(base)).toThrow(/must either name an already-running server with baseURL/)
  })

  it('rejects an empty provider, display name, or model list', () => {
    expect(() => resolveConfig({ ...base, provider: '', server: { ...serverDefaults } }))
      .toThrow(/provider must be a non-empty route key/)
    expect(() => resolveConfig({ ...base, displayName: '', server: { ...serverDefaults } }))
      .toThrow(/displayName must not be empty/)
    expect(() => resolveConfig({ ...base, models: [], server: { ...serverDefaults } }))
      .toThrow(/models must list at least one model/)
  })

  it('rejects an unusable model entry', () => {
    const withServer = (models: LitertModelConfig[]): Config => ({ ...base, models, server: { ...serverDefaults } })
    expect(() => resolveConfig(withServer([{ ...model, id: '' }]))).toThrow(/a model has an empty id/)
    expect(() => resolveConfig(withServer([model, model]))).toThrow(/is listed more than once/)
    expect(() => resolveConfig(withServer([{ ...model, file: '' }]))).toThrow(/has an empty file/)
    expect(() => resolveConfig(withServer([{ ...model, huggingFaceRepo: '' }])))
      .toThrow(/has an empty huggingFaceRepo/)
  })

  it('refuses an import instruction on a route that supervises nothing', () => {
    expect(() => resolveConfig({ ...base, baseURL: 'http://localhost:9379/v1' }))
      .toThrow(/names huggingFaceRepo, but this route points at an already-running server/)
  })

  it('rejects a baseURL the route could not send a request to', () => {
    const remote = (baseURL: string): Config => ({ provider: 'litert', models: [importedElsewhere()], baseURL })
    expect(() => resolveConfig(remote(''))).toThrow(/baseURL must not be empty/)
    expect(() => resolveConfig(remote('/v1'))).toThrow(/is not an absolute URL/)
    expect(() => resolveConfig(remote('ftp://litert.example/v1'))).toThrow(/must use http or https/)
  })

  it('rejects every unusable supervision tunable', () => {
    const local = (server: Partial<ResolvedLitertServerConfig>): Config =>
      ({ ...base, server: { ...serverDefaults, ...server } })
    expect(() => resolveConfig(local({ command: '' }))).toThrow(/server\.command must not be empty/)
    expect(() => resolveConfig(local({ host: '' }))).toThrow(/server\.host must not be empty/)
    expect(() => resolveConfig(local({ cwd: '' }))).toThrow(/server\.cwd must not be empty/)
    expect(() => resolveConfig(local({ port: 0 }))).toThrow(/server\.port must be an integer from 1 through 65535/)
    expect(() => resolveConfig(local({ port: 70_000 }))).toThrow(/server\.port must be an integer from 1 through 65535/)
    expect(() => resolveConfig(local({ startupTimeoutMs: 0 }))).toThrow(/server\.startupTimeoutMs must be a positive integer/)
    expect(() => resolveConfig(local({ healthIntervalMs: 2_147_483_648 })))
      .toThrow(/server\.healthIntervalMs must be a positive integer no greater than 2147483647/)
    expect(() => resolveConfig(local({ shutdownGraceMs: -1 }))).toThrow(/server\.shutdownGraceMs must be a positive integer/)
    expect(() => resolveConfig(local({ importTimeoutMs: 1.5 }))).toThrow(/server\.importTimeoutMs must be a positive integer/)
    expect(() => resolveConfig(local({ maxStderrBytes: 0 }))).toThrow(/server\.maxStderrBytes must be a positive integer/)
    expect(() => resolveConfig(local({ startupTimeoutMs: 100, healthIntervalMs: 500 })))
      .toThrow(/healthIntervalMs \(500\) must not exceed server\.startupTimeoutMs \(100\)/)
  })
})

/** Concrete subprocess service backed by one {@link FakeLitert} recorder. */
class FakeSubprocessRuntime extends SubprocessRuntime {
  static recorder = new FakeLitert({})

  async resolveExecutable(command: string): Promise<string> {
    return `/usr/local/bin/${command}`
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return FakeSubprocessRuntime.recorder.spawn(spec)
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return {
      pid: spec.argv.length,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => undefined,
      signalForeground: async () => 1,
      terminate: async () => {},
    }
  }
}

/** Boot an `llm` seam over a recording subprocess service. */
async function boot(recorder: FakeLitert): Promise<Context> {
  FakeSubprocessRuntime.recorder = recorder
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FakeSubprocessRuntime)
  return ctx
}

/** Mount the plugin with an injected probe, as `apply`'s third parameter allows. */
function mount(ctx: Context, config: Config, probe: LitertHealthProbe) {
  return ctx.plugin({
    name: 'llm-litert-test',
    inject: ['llm', 'subprocess'],
    apply: (pluginCtx: Context) => litert.apply(pluginCtx, litert.Config(config), probe),
  })
}

describe('llm-litert plugin', () => {
  it('registers a remote route on ctx.llm and spawns no process at all', async () => {
    const recorder = new FakeLitert({})
    const ctx = await boot(recorder)
    const { probe, urls } = scriptedProbe([true])
    const fiber = await mount(ctx, {
      provider: 'litert',
      displayName: 'LiteRT on Railway',
      models: [{ id: 'gemma4-e2b', file: 'gemma-4-E2B-it.litertlm', contextWindow: 32_768, maxTokens: 4_096 }],
      baseURL: 'https://litert.up.railway.app/v1',
    }, probe)
    expect(recorder.spawns).toHaveLength(0)
    expect(urls).toHaveLength(0)
    expect(ctx.llm.listProviders().map(entry => entry.id)).toContain('litert')
    expect((await ctx.llm.listModels('litert')).map(entry => entry.id)).toEqual(['gemma4-e2b'])
    await fiber.dispose()
    expect(ctx.llm.listProviders().map(entry => entry.id)).not.toContain('litert')
  })

  it('supervises a local server, registers the route, and stops the process on fiber dispose', async () => {
    const recorder = new FakeLitert({
      list: { stdout: 'ID SIZE MODIFIED\n' },
      import: {},
      serve: { lingers: true },
    })
    const ctx = await boot(recorder)
    const { probe } = scriptedProbe([true])
    const fiber = await mount(ctx, {
      provider: 'litert',
      models: [model],
      server: { cwd: '/srv/litert', healthIntervalMs: 5, startupTimeoutMs: 2_000 },
    }, probe)
    expect(recorder.subcommands()).toEqual(['list', 'import', 'serve'])
    expect(ctx.llm.listProviders().map(entry => entry.id)).toContain('litert')
    const serve = recorder.handles[2]
    expect(serve?.terminateCount).toBe(0)
    await fiber.dispose()
    expect(serve?.terminateCount).toBe(1)
    expect(ctx.llm.listProviders().map(entry => entry.id)).not.toContain('litert')
  })

  it('leaves no route and no process behind when startup never becomes healthy', async () => {
    const recorder = new FakeLitert({ list: { stdout: 'gemma4-e2b\n' }, serve: { lingers: true } })
    const ctx = await boot(recorder)
    const { probe } = scriptedProbe([false])
    await expect(mount(ctx, {
      provider: 'litert',
      models: [model],
      server: { cwd: '/srv/litert', startupTimeoutMs: 40, healthIntervalMs: 10 },
    }, probe)).rejects.toThrow(/did not answer GET/)
    expect(recorder.handles[1]?.terminateCount).toBe(1)
    expect(ctx.llm.listProviders().map(entry => entry.id)).not.toContain('litert')
  })

  it('refuses a schema-invalid tunable before anything is spawned', async () => {
    const recorder = new FakeLitert({})
    const ctx = await boot(recorder)
    await expect(ctx.plugin(litert, {
      provider: 'litert',
      models: [model],
      server: { cwd: '/srv/litert', port: 70_000 },
    })).rejects.toThrow()
    await expect(ctx.plugin(litert, {
      provider: 'litert',
      models: [model],
      server: { cwd: '/srv/litert', startupTimeoutMs: 2_147_483_648 },
    })).rejects.toThrow()
    expect(recorder.spawns).toHaveLength(0)
  })

  it('refuses a route that names both postures at apply time', async () => {
    const recorder = new FakeLitert({})
    const ctx = await boot(recorder)
    const { probe } = scriptedProbe([true])
    await expect(mount(ctx, {
      provider: 'litert',
      models: [{ id: 'gemma4-e2b', file: 'gemma-4-E2B-it.litertlm', contextWindow: 32_768, maxTokens: 4_096 }],
      baseURL: 'http://127.0.0.1:9379/v1',
      server: { cwd: '/srv/litert' },
    }, probe)).rejects.toThrow(/the two postures of one route/)
    expect(recorder.spawns).toHaveLength(0)
  })
})
