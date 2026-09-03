/**
 * Cross-artifact gate for `deploy/litert`. The image, its entrypoint, and the
 * Railway Infrastructure as Code file each hold half of an invariant the other
 * half cannot state: the volume mount is the registry directory, the health
 * check is the path this package probes for readiness, and every environment
 * guard names a variable no image layer sets. Nothing else executes these
 * files, so this suite is where they are checked.
 *
 * The IaC file is read the two ways it can fail. `railway config apply`
 * rejects a call the published `railway/iac` declarations reject, so the file
 * is compiled here under its own `deploy/litert/tsconfig.json`; and an option
 * Railway silently ignores because it is misspelled is simply absent from the
 * graph, so every service setting below is read from the graph `defineRailway`
 * returns rather than from the file's source text.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRailwayContext, project } from 'railway/iac'
import type { RailwayProgram, ResourceNode, ServiceNode, VolumeNode } from 'railway/iac'
import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

const ROOT = new URL('../../../../', import.meta.url)
const DEPLOY_DIR = new URL('deploy/litert/', ROOT)

/** Read one deployment artifact as text. */
function read(name: string): string {
  return readFileSync(new URL(name, DEPLOY_DIR), 'utf8')
}

const dockerfile = read('Dockerfile')
const entrypoint = read('entrypoint.sh')

/**
 * The endpoint a route supervising its own `litert-lm serve` resolves to, with
 * every schema default applied. It carries the two facts the deployment must
 * agree with: the port the CLI binds when nothing injects one, and the path
 * prefix the readiness probe requests under.
 */
const localBaseURL = new URL(
  resolveConfig(Config({
    provider: 'litert',
    models: [{ id: 'gemma4-e2b', file: 'gemma-4-E2B-it.litertlm', contextWindow: 1, maxTokens: 1 }],
    server: { cwd: '/srv/litert' },
  })).endpoint.baseURL,
)

/**
 * Compile the IaC file against the `railway/iac` declarations the installed
 * `railway` package publishes. `--force` is required: the project keeps a
 * `.tsbuildinfo`, and a cached result would report a stale tree as clean.
 */
function typecheckIacProject(): string {
  try {
    execFileSync(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '--build', '--force', 'deploy/litert/tsconfig.json'],
      { cwd: fileURLToPath(ROOT), stdio: 'pipe' },
    )
    return ''
  } catch (failure: unknown) {
    const diagnostics = failure as { stdout?: Buffer; stderr?: Buffer }
    return `${diagnostics.stdout?.toString() ?? ''}${diagnostics.stderr?.toString() ?? ''}`
  }
}

/**
 * Evaluate the IaC file the way `railway config plan` does, and return the
 * resources the project declares.
 */
async function railwayResources(): Promise<ResourceNode[]> {
  const loaded: unknown = await import(new URL('.railway/railway.ts', DEPLOY_DIR).href)
  const program = (loaded as { default: RailwayProgram }).default
  const definition = await program(createRailwayContext({ command: 'plan', environment: 'production' }), project)
  return (definition.resources ?? []).flat()
}

/**
 * The one resource of `kind` the IaC program declares.
 *
 * Narrowing at the binding rather than through a module-level guard: a guard
 * does not narrow a `const` the helpers below capture, because their call time
 * is unknown to the compiler.
 * @param kind - the resource discriminant to select.
 * @param resources - every resource the program returned.
 * @returns that resource, typed non-optional.
 * @throws when the program declares no such resource.
 */
function only<T extends ResourceNode>(kind: T['type'], resources: readonly ResourceNode[]): T {
  const found = resources.find((resource): resource is T => resource.type === kind)
  if (found === undefined) {
    throw new Error(`deploy/litert/.railway/railway.ts must declare one ${kind}`)
  }
  return found
}

/** The IaC module's own named exports, which the CLI reads beside the program. */
const railwayModule = await import(new URL('.railway/railway.ts', DEPLOY_DIR).href) as { partial?: unknown }

const resources = await railwayResources()
const litert = only<ServiceNode>('service', resources)
const models = only<VolumeNode>('volume', resources)
const attachment = litert.volumeAttachments?.[models.name]

/** Value of one `ENV NAME=value` line in the image. */
function imageEnv(name: string): string | undefined {
  return new RegExp(`^ENV ${name}=(.+)$`, 'm').exec(dockerfile)?.[1]
}

/** Every variable the image bakes into its environment. */
function imageEnvNames(): string[] {
  return [...dockerfile.matchAll(/^ENV (\w+)=/gm)].map(match => match[1] ?? '')
}

/**
 * Value of one service variable the IaC file sets to a literal. Railway's
 * variable kinds are open, and only a literal carries a value to compare.
 */
function serviceLiteral(name: string): string | undefined {
  const variable = litert.variables?.[name]
  if (variable === undefined || variable.type !== 'literal') return undefined
  return variable.value ?? undefined
}

/** Every region the service pins, across both the single- and multi-region forms. */
function serviceRegions(): string[] {
  const single = litert.deploy?.region
  return [
    ...(single === undefined || single === null ? [] : [single]),
    ...Object.keys(litert.deploy?.multiRegionConfig ?? {}),
  ]
}

/** Every variable the entrypoint refuses to start without. */
function guardedVariables(): string[] {
  return [...entrypoint.matchAll(/^: "\$\{(\w+):\?/gm)].map(match => match[1] ?? '')
}

/** Every model-identity variable the entrypoint reads. */
function modelVariables(): string[] {
  return [...new Set([...entrypoint.matchAll(/\$\{(LITERT_\w+)[:}]/g)].map(match => match[1] ?? ''))]
}

/** The one line that starts the server. */
function serveLine(): string {
  return entrypoint.split('\n').find(line => line.startsWith('exec ')) ?? ''
}

describe('deploy/litert', () => {
  it('compiles against the railway/iac declarations the CLI evaluates it with', () => {
    // The Railway CLI reports a rejected call at `railway config apply`, after
    // a person has already linked a project. This is the same rejection, here.
    expect(typecheckIacProject()).toBe('')
  })

  it('configures the service through Infrastructure as Code, not deprecated Config as Code', () => {
    // New Railway services cannot opt into Config as Code, and existing files
    // stop being read on 2026-12-01, so leaving one here would be dead weight
    // that also blocks `railway config plan` on the same service.
    expect(existsSync(new URL('railway.json', DEPLOY_DIR))).toBe(false)
    expect(existsSync(new URL('railway.toml', DEPLOY_DIR))).toBe(false)
  })

  it('scopes its ownership with a named partial, so an apply deletes nothing it did not create', () => {
    // Railway IaC treats omission as deletion. This file describes one service
    // and is applied to an environment its deployer owns, so without a partial
    // `railway config apply` would remove their unrelated resources. The name
    // is applied state: it must match what the file's own resources are keyed
    // under, and renaming it after an apply orphans what the old name owned.
    expect(railwayModule.partial).toBe(litert.name)
  })

  it('mounts the volume where the image resolves the litert-lm registry', () => {
    // The mount path, the service's HOME, and the image's HOME are one path:
    // `litert-lm` resolves its registry as `$HOME/.litert-lm`, so any two of
    // the three disagreeing puts the registry outside the volume.
    expect(attachment?.mountPath).toBe(imageEnv('HOME'))
    expect(serviceLiteral('HOME')).toBe(attachment?.mountPath)
  })

  it('leaves the volume in the region of the service that mounts it', () => {
    // Railway provisions a volume in its service's region, and attaching one
    // across regions forces a migration with downtime. Pinning a region on the
    // volume alone is that cross-region attach; neither pins one here, so both
    // follow the deployer's own preferred region.
    const region = models.config?.region ?? undefined
    const pinned = region === undefined ? [] : [region]
    expect(pinned.filter(name => !serviceRegions().includes(name))).toEqual([])
  })

  it('health-checks the path this package probes for readiness', () => {
    // `LitertServer.awaitHealthy` requests `${baseURL}/models`; a health check
    // on any other path would call a server ready that cannot serve a model.
    expect(litert.deploy?.healthcheckPath).toBe(new URL(`${localBaseURL.href}/models`).pathname)
  })

  it('binds the injected port rather than the CLI default', () => {
    expect(serveLine()).toContain('--host 0.0.0.0')
    expect(serveLine()).toContain('--port "${PORT}"')
    expect(serveLine()).not.toContain(localBaseURL.port)
  })

  it('guards every variable no image layer sets, and none that one does', () => {
    const guarded = guardedVariables()
    const baked = imageEnvNames()
    const supplied = Object.keys(litert.variables ?? {})
    expect(modelVariables().length).toBeGreaterThan(0)
    for (const name of modelVariables()) {
      // Live guard: unset until the service supplies it, and fatal when unset.
      expect(guarded).toContain(name)
      expect(baked).not.toContain(name)
      expect(supplied).toContain(name)
    }
    expect(guarded).toContain('PORT')
    expect(supplied).not.toContain('PORT')
    // HOME is the one variable the image owns, so a guard on it would be dead.
    expect(baked).toContain('HOME')
    expect(guarded).not.toContain('HOME')
  })

  it('declares one replica, because a volume attaches to one', () => {
    expect(litert.deploy?.numReplicas).toBe(1)
  })
})
