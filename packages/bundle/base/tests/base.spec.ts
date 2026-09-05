/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown>; disabled?: boolean }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'",
    })
    expect(rows.find(row => row.id === 'hmr')).toMatchObject({
      disabled: true,
      config: { root: ['.'] },
    })
    // Half a seam is the failure this pins: the browser ships an
    // `approval-assessor` settings card, and the card only renders for a
    // namespace the Host serves. Mounted here and enabled by default, because a
    // screen against an agent arguing its way out of instructed work is worth
    // nothing when a deployment has to opt in.
    expect(rows.find(row => row.id === 'approval-assessor')).toMatchObject({
      name: '@deepseek-ai/dsh-approval-assessor',
    })
    expect(rows.find(row => row.id === 'approval-assessor')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'approval-assessor')?.config).toBeUndefined()
    // The adversary replaces the human answerer once enabled, so the base
    // ships it mounted behind the assessor but off: the browser card renders
    // for the served namespace, and enabling it is a user's decision.
    expect(rows.indexOf(rows.find(row => row.id === 'approval-adversary')!))
      .toBe(rows.indexOf(rows.find(row => row.id === 'approval-assessor')!) + 1)
    expect(rows.find(row => row.id === 'approval-adversary')).toMatchObject({
      name: '@deepseek-ai/dsh-approval-adversary',
      config: { enabled: false, fallback: 'delegate', timeoutMs: 30000, maxOutputTokens: 256, maxExcerptChars: 4000 },
    })
    expect(rows.find(row => row.id === 'approval-adversary')?.disabled).toBeUndefined()
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    // Fetch renders the page: a model reading a modern site through a raw HTTP
    // body sees an empty shell. Both providers are mounted and the route is
    // named, because the seam refuses to guess when two are usable. The rendered
    // route needs `playwright install chromium`, which the bundle README states.
    expect(rows.find(row => row.id === 'web')?.config).toMatchObject({ fetchProvider: 'playwright' })
    expect(rows.find(row => row.id === 'web-fetch-playwright')).toBeDefined()
    expect(rows.find(row => row.id === 'web-fetch-playwright')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'web-fetch-http')).toBeDefined()
    expect(rows.find(row => row.id === 'tool-web')?.config).toMatchObject({ fetch: false })
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-claude-code')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-fetch-http')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-fetch-playwright')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-approval-assessor')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-approval-adversary')
  })

  it('gates the executors by platform and selects the shell tool dialect from the same fact', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: the two executor rows carry the same platform fact
    // inverted, so exactly one executor mounts per host. Evaluate with a
    // platform-scoped context (the `with` scope shadows the global `process`)
    // so both outcomes pin on every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['pwsh-sandbox', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // One model-facing shell tool mounts unconditionally; the SAME platform
    // fact selects the dialect it speaks, so the tool name always matches the
    // executor that mounted above.
    const shellTool = rows.find(candidate => candidate.id === 'tool-shell')
    if (shellTool === undefined) throw new Error('base patch must mount tool-shell')
    expect(shellTool.disabled, 'tool-shell is never platform-gated').toBeUndefined()
    const dialect = (shellTool.config as { dialect?: { __jsExpr?: string } } | undefined)?.dialect?.__jsExpr
    if (dialect === undefined) throw new Error('tool-shell must select its dialect with a !!js expression')
    expect(evaluate({ process: { platform: 'win32' } }, dialect), 'tool-shell dialect on win32').toBe('pwsh')
    expect(evaluate({ process: { platform: 'linux' } }, dialect), 'tool-shell dialect on linux').toBe('bash')
    // No second row can register a competing shell-tool name.
    expect(rows.filter(candidate => candidate.name === '@deepseek-ai/dsh-tool-shell')).toHaveLength(1)
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})
