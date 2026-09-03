/**
 * The shipped shell composition: the base bundle gates the two executors by
 * platform on their own rows (`disabled: !!js process.platform`) and selects
 * the one shell tool's dialect from the same fact, so exactly one shell stack
 * mounts per host and no separate platform layer exists — the launcher applies
 * nothing beyond the bundle layers. The spec composes the REAL shipped bundle
 * layers (dsh-base + dsh-web-app resolved from the app installation anchor)
 * through the boot's patch algorithm and pins the effective per-platform
 * roster, the preset-level dialect selection that gives a win32 session `pwsh`
 * and a POSIX session `bash`, and the cold-start resolution closure for the
 * pwsh rows' bare plugin names.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import { composeEntries, initProfile, loadProfile, PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'

/**
 * The effective disabled state of one row on one platform: a `!!js` expression
 * evaluates with a platform-scoped `process` so both outcomes pin on any host.
 */
function disabledOn(row: { disabled?: unknown }, platform: 'win32' | 'linux'): boolean {
  const value = row.disabled
  if (value !== null && typeof value === 'object' && '__jsExpr' in value) {
    return Boolean(evaluate({ process: { platform } }, (value as { __jsExpr: string }).__jsExpr))
  }
  return value === true
}

/**
 * The shell dialect one row selects on one platform: the `dialect` config value
 * is a `!!js` expression, evaluated with a platform-scoped `process`.
 */
function dialectOn(row: { config?: unknown }, platform: 'win32' | 'linux'): unknown {
  const config = row.config
  const dialect = typeof config === 'object' && config !== null
    ? (config as { dialect?: unknown }).dialect
    : undefined
  if (dialect === null || typeof dialect !== 'object' || !('__jsExpr' in dialect)) {
    throw new TypeError('the shell tool row must select its dialect with a !!js expression')
  }
  return evaluate({ process: { platform } }, (dialect as { __jsExpr: string }).__jsExpr)
}

describe('the shipped shell composition (real bundle layers)', () => {
  let home: string
  afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }) })
  // The app installation anchor, mirroring profile-boot.ts: the bundle layers
  // resolve from the REAL dsh-base/dsh-web-app packages through it, so this
  // suite composes the shipped patch files, not test fixtures.
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url))

  it('composes the confined pwsh roster on win32 and the bash roster on POSIX from the same rows', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-windows-home-'))
    initProfile(join(home, PROFILES_DIR, 'web'), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const profile = loadProfile('dsh', 'web', anchor, home)
    const warnings: string[] = []
    const rows = composeEntries(
      profile.layers.map(layer => layer.patches),
      message => warnings.push(message),
    )
    const byId = new Map(rows.map(row => [row.id, row]))
    // One shared patch set, two rosters: the executors gate themselves and the
    // single shell-tool row follows the same platform fact.
    for (const id of ['bash-sandbox', 'pwsh-sandbox', 'tool-shell']) {
      expect(byId.has(id), `row ${id}`).toBe(true)
    }
    expect(disabledOn(byId.get('bash-sandbox')!, 'win32'), 'bash-sandbox on win32').toBe(true)
    expect(disabledOn(byId.get('bash-sandbox')!, 'linux'), 'bash-sandbox on linux').toBe(false)
    expect(disabledOn(byId.get('pwsh-sandbox')!, 'win32'), 'pwsh-sandbox on win32').toBe(false)
    expect(disabledOn(byId.get('pwsh-sandbox')!, 'linux'), 'pwsh-sandbox on linux').toBe(true)
    // The host shell-tool row is disabled on every platform; sessions mount
    // their own row instead.
    expect(byId.get('tool-shell')?.disabled).toBe(true)
    // The permission surface never moves: the sandbox/policy rows, the
    // permission switcher, fs-sandbox, and the approval service stay enabled
    // exactly as on POSIX — the confined pwsh executor is what changes.
    for (const id of ['permission', 'ui-permission', 'sandbox', 'sandbox-policy', 'fs-sandbox', 'approval']) {
      expect(byId.get(id)?.disabled, `row ${id}`).not.toBe(true)
    }
    // The launcher's cold-start module fallback BFS-links the apps/cli
    // dependency closure into the profile's node_modules, so every bare
    // plugin name in the base patch must resolve from there.
    const cliManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of ['@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-shell']) {
      expect(cliManifest.dependencies?.[name], `cold-start closure must reach ${name}`).toBeDefined()
    }
    expect(warnings).toEqual([])
  })

  it('base-only profiles carry both executors gated by platform and one dialect-selecting tool row', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-windows-home-'))
    initProfile(join(home, PROFILES_DIR, 'base-only'), ['@deepseek-ai/dsh-base'])
    const profile = loadProfile('dsh', 'base-only', anchor, home)
    const warnings: string[] = []
    const rows = composeEntries(
      profile.layers.map(layer => layer.patches),
      message => warnings.push(message),
    )
    const byId = new Map(rows.map(row => [row.id, row]))
    for (const id of ['bash-sandbox', 'pwsh-sandbox', 'tool-shell']) {
      expect(byId.has(id), `row ${id}`).toBe(true)
    }
    // No web overlay: the tool row stays enabled and names its dialect from the
    // same platform fact the executors gate on.
    expect(disabledOn(byId.get('tool-shell')!, 'win32'), 'tool-shell on win32').toBe(false)
    expect(disabledOn(byId.get('tool-shell')!, 'linux'), 'tool-shell on linux').toBe(false)
    expect(dialectOn(byId.get('tool-shell')!, 'win32')).toBe('pwsh')
    expect(dialectOn(byId.get('tool-shell')!, 'linux')).toBe('bash')
    expect(warnings).toEqual([])
  })
})

describe('shipped agent presets select one shell tool dialect per platform', () => {
  const presetRoot = SHIPPED_PRESET_ROOT

  it.each(['standard', 'ptc', 'cordis'])('preset %s mounts one shell tool row whose dialect follows the platform', (preset) => {
    const entries: unknown = yaml.load(
      readFileSync(join(presetRoot, preset, 'agent.cordis.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(entries)) throw new TypeError(`preset ${preset} must parse to an entry array`)
    const shellRows = entries.filter((entry): entry is Record<string, unknown> => (
      typeof entry === 'object' && entry !== null
      && (entry as Record<string, unknown>).name === '@deepseek-ai/dsh-tool-shell'
    ))
    expect(shellRows, `preset ${preset} must mount exactly one shell tool row`).toHaveLength(1)
    const row = shellRows[0]!
    expect(row.disabled, `preset ${preset} must not platform-gate its shell tool row`).toBeUndefined()
    // A platform-scoped context pins both outcomes on every host.
    expect(dialectOn(row, 'win32'), `${preset} dialect on win32`).toBe('pwsh')
    expect(dialectOn(row, 'linux'), `${preset} dialect on linux`).toBe('bash')
  })

  it('minimal mounts no shell tool row and gates its persistent shell stack by platform', () => {
    const entries: unknown = yaml.load(
      readFileSync(join(presetRoot, 'minimal', 'agent.cordis.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(entries)) throw new TypeError('minimal preset must parse to an entry array')
    expect(entries.some(entry => (
      typeof entry === 'object' && entry !== null
      && (entry as Record<string, unknown>).name === '@deepseek-ai/dsh-tool-shell'
    )), 'the one-shot shell tool must be absent from minimal').toBe(false)
    const group = entries.find((entry): entry is Record<string, unknown> => (
      typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === 'persistent-shell'
    ))
    if (group === undefined) throw new TypeError('minimal preset must mount persistent-shell')
    const rows = group.config as unknown[]
    if (!Array.isArray(rows)) throw new TypeError('persistent-shell must carry a row list')
    const byId = new Map(rows
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map(entry => [entry.id, entry]))
    // The bash stack (terminal-bash + persistent-bash) mounts on POSIX only; the
    // pwsh rows (terminal-bash with shellDialect pwsh + persistent-pwsh, both
    // naming the same persistent shell tool package with `dialect: pwsh`) mount
    // on win32 only — exactly one persistent shell per host.
    for (const id of ['terminal-bash', 'persistent-bash']) {
      expect(disabledOn(byId.get(id)!, 'win32'), `${id} on win32`).toBe(true)
      expect(disabledOn(byId.get(id)!, 'linux'), `${id} on linux`).toBe(false)
    }
    for (const id of ['terminal-pwsh', 'persistent-pwsh']) {
      expect(disabledOn(byId.get(id)!, 'win32'), `${id} on win32`).toBe(false)
      expect(disabledOn(byId.get(id)!, 'linux'), `${id} on linux`).toBe(true)
    }
    expect(byId.get('terminal-pwsh')?.config).toMatchObject({ shellDialect: 'pwsh' })
    expect(byId.get('persistent-bash')?.config).toMatchObject({ dialect: 'bash' })
    expect(byId.get('persistent-pwsh')?.config).toMatchObject({ dialect: 'pwsh' })
  })
})
