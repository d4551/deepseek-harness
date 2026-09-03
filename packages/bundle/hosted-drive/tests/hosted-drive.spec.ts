/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list, that list must replace the
 * host-local filesystem rather than layer a second one beside it, and every
 * package it mounts must be one the manifest installs.
 *
 * Agreement between the sandbox fence and the materialization root is NOT
 * asserted here. Both rows read one environment variable in this same file, so
 * a comparison of them can only fail by editing it; the composition that
 * actually has to agree is checked against live values by the invariant this
 * patch mounts (`invariant-composition.spec.ts`).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

interface PatchRow {
  id?: string
  name?: string
  config?: Record<string, unknown>
  disabled?: boolean
}

const root = fileURLToPath(new URL('..', import.meta.url))

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

/**
 * Read the patch and resolve its `!!js` config values through the loader's own
 * evaluator, so each row carries what a real boot with this environment would
 * see rather than the deferred expression marker.
 * @param env - the drive variables the expressions read.
 * @returns every row the patch states, inserts included, with config evaluated.
 */
function patchRows(env: Record<string, string>): PatchRow[] {
  const parsed = yaml.load(
    readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
    { schema: entryListSchema },
  ) as (PatchRow & { insert?: PatchRow[] })[]
  const scope = { process: { env, platform: process.platform } }
  return parsed.flatMap(row => row.insert ?? [row]).map((row) => {
    if (row.config === undefined) return row
    const config: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row.config)) {
      config[key] = isExpression(value) ? evaluate(scope, value.__jsExpr) : value
    }
    return { ...row, config }
  })
}

/**
 * Whether a parsed config value is a deferred `!!js` expression.
 * @param value - one parsed config value.
 * @returns true when the loader will evaluate it at boot.
 */
function isExpression(value: unknown): value is { __jsExpr: string } {
  return typeof value === 'object' && value !== null && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string'
}

const ENV = {
  DSH_DRIVE_URL: 'https://drive.example/collection',
  DSH_DRIVE_USERNAME: 'DSH_DRIVE_USERNAME',
  DSH_DRIVE_PASSWORD: 'DSH_DRIVE_PASSWORD',
  DSH_DRIVE_WORKSPACE: '/srv/dsh/workspace',
  DSH_DRIVE_REMOTE_ROOT: 'projects/one',
}

describe('dsh-hosted-drive bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(patchRows(ENV).length).toBeGreaterThan(0)
  })

  it('replaces the host-local filesystem instead of layering a second provider', () => {
    // Two `ctx.fs` providers in one tree would give the model two workspaces,
    // and Cordis refuses a duplicate service registration outside a realm.
    const rows = patchRows(ENV)
    expect(rows.find(row => row.id === 'fs-sandbox')).toMatchObject({ disabled: true })
    expect(rows.find(row => row.id === 'fs-network-drive')?.name).toBe('@deepseek-ai/dsh-fs-network-drive')
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-fs-local')).toHaveLength(0)
  })

  it('resolves the drive endpoint and credential references from the environment', () => {
    const drive = patchRows(ENV).find(row => row.id === 'network-drive')
    expect(drive?.name).toBe('@deepseek-ai/dsh-network-drive-webdav')
    expect(drive?.config).toMatchObject({
      url: ENV.DSH_DRIVE_URL,
      authType: 'password',
      usernameEnv: 'DSH_DRIVE_USERNAME',
      passwordEnv: 'DSH_DRIVE_PASSWORD',
    })
    // The password itself is never a config value: the row carries the name of
    // a credential the credential seam resolves.
    expect(JSON.stringify(drive?.config)).not.toContain('DSH_DRIVE_PASSWORD_VALUE')
  })

  it('mirrors the drive root when no remote subtree is named', () => {
    const rows = patchRows({ ...ENV, DSH_DRIVE_REMOTE_ROOT: '' })
    expect(rows.find(row => row.id === 'fs-network-drive')?.config?.['remoteRoot']).toBe('')
  })

  it('depends on every package its patch mounts', () => {
    // The relation is across two files: a row naming a plugin the manifest does
    // not carry installs nothing in a profile. A subpath specifier such as
    // `<package>/invariant` is carried by its package, and this bundle's own
    // subpaths need no self-dependency.
    const mounted = patchRows(ENV)
      .map(row => row.name)
      .filter((name): name is string => name?.startsWith('@deepseek-ai/') === true)
      .map(name => name.split('/').slice(0, 2).join('/'))
      .filter(name => name !== '@deepseek-ai/dsh-hosted-drive')
    expect(mounted.length).toBeGreaterThan(0)
    for (const name of new Set(mounted)) {
      expect(manifest.dependencies, name).toHaveProperty(name)
    }
  })
})
