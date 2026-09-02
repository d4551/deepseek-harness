/**
 * Runtime conformance for every package-owned invariant companion.
 *
 * `verify-package-invariants` reads the source and the manifests; nothing
 * proved that a companion, once loaded, actually reserves its package with the
 * registry. A companion whose `apply` returned without registering, or whose
 * plugin name was empty, satisfied every static rule the repository had.
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const root = resolve(import.meta.dirname, '..')

/** Every package directory that owns a source invariant companion. */
function companionOwners(): { directory: string; manifestName: string }[] {
  return globSync('packages/*/*/src/invariant.ts', { cwd: root })
    .map(entry => dirname(dirname(entry)))
    .sort()
    .map((directory) => {
      const manifest = JSON.parse(
        readFileSync(resolve(root, directory, 'package.json'), 'utf8'),
      ) as { name: string }
      return { directory, manifestName: manifest.name }
    })
}

/**
 * Companions whose `./invariant` subpath has no tsconfig path mapping, so the
 * source plane cannot import them. `gen-tsconfig-paths` emits mappings only for
 * packages whose declared name equals their directory; these carry hand-written
 * aliases that cover the main entry alone. Pinned rather than filtered: the list
 * is asserted exactly, so it cannot grow without this test failing.
 */
const UNMAPPED_SUBPATHS: readonly string[] = [
  '@deepseek-ai/dsh-agent-team-profile',
  '@deepseek-ai/dsh-agent-team-web-profile',
  '@deepseek-ai/dsh-client-ui-agent-team',
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-sdk-protocol',
  '@deepseek-ai/dsh-typert-generator',
  '@deepseek-ai/dsh-typert-loader',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-util-workspace-path',
]

const OWNERS = companionOwners()
const IMPORTABLE = OWNERS.filter(owner => !UNMAPPED_SUBPATHS.includes(owner.manifestName))

describe('package invariant companions', () => {
  it('finds every package that owns a companion', () => {
    // An empty sweep would make every assertion below vacuous.
    expect(OWNERS.length).toBeGreaterThan(200)
    // The unmapped list is exactly what it claims: every other companion is
    // exercised below, so a newly unimportable one fails here instead of
    // quietly leaving the sweep.
    expect(OWNERS.filter(owner => UNMAPPED_SUBPATHS.includes(owner.manifestName))
      .map(owner => owner.manifestName).sort())
      .toEqual([...UNMAPPED_SUBPATHS].sort())
  })

  it.each(IMPORTABLE.map(owner => [owner.manifestName, owner] as const))(
    '%s reserves its package with the invariant registry',
    async (_label, owner) => {
      const companion = await import(/* @vite-ignore */ `${owner.manifestName}/invariant`) as {
        name: string
        inject: readonly string[]
        apply: (ctx: Context) => Promise<() => void>
      }

      // The Cordis plugin name need not mirror the manifest — several
      // companions are named for their role — but it must exist and say what
      // it is. The manifest name is what the registry reservation must carry.
      expect(companion.name).toMatch(/^[a-z0-9-]+-invariant$/)
      expect(companion.inject).toContain('invariants')

      const ctx = new Context()
      await ctx.plugin(InvariantRegistry, { enabled: true })
      const reserved: string[] = []
      const registry = ctx.invariants as unknown as { register(name: string, installer: unknown): () => void }
      const register = registry.register.bind(registry)
      registry.register = (name: string, installer: unknown) => {
        reserved.push(name)
        return register(name, installer)
      }

      const dispose = await companion.apply(ctx)
      expect(reserved).toEqual([owner.manifestName])
      expect(typeof dispose).toBe('function')
    },
  )
})
