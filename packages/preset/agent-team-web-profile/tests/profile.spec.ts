/**
 * The `swarm-web` browser bundle must carry one parseable Team Client layer,
 * and must be publishable: `swarm-web` is a shipped template, so a packed
 * `@deepseek-ai/dsh` install has to be able to resolve this bundle by name.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as WebProfileInvariant from '../src/invariant.ts'

describe('Agent Teams Web profile bundle', () => {
  it('declares a publishable parseable layer containing the Team UI', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: { access?: string }
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@deepseek-ai/dsh-client-ui-agent-team': 'workspace:^',
    })

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: { id?: string; name?: string }[] }[]
    expect(parsed.flatMap(patch => patch.insert ?? [])).toEqual([
      { id: 'ui-agent-team', name: '@deepseek-ai/dsh-client-ui-agent-team' },
    ])
  })

  it('reserves package ownership without installing a runtime audit', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(WebProfileInvariant)
    await fiber.await()
    expect(WebProfileInvariant.name).toBe('agent-team-web-profile-invariant')
    expect(WebProfileInvariant.inject).toEqual(['invariants'])
    expect(() => {
      Reflect.apply(ctx.emit.bind(ctx), undefined, ['unrelated/event'])
    }).not.toThrow()
    await fiber.dispose()
  })
})
