/**
 * `dsh init`: profile generation from the shipped template, the default base
 * layer, explicit `--bundle` layers, idempotent reruns that keep user edits,
 * and the layer checks that stop an unbootable manifest from being written.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_TEMPLATES, type ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { resolveInitTemplate, runInit } from '../src/init.ts'

const tmpHome = (): string => mkdtempSync(join(tmpdir(), 'dsh-init-'))

/** One generator run against `home`, with its report captured instead of printed. */
function init(name: string, bundles: string[] = [], home: string = tmpHome()): {
  code: number
  out: string
  dir: string
  home: string
} {
  vi.stubEnv('DSH_HOME', home)
  const lines: string[] = []
  const code = runInit(name, bundles, (line) => { lines.push(line) })
  return { code, out: lines.join(''), dir: join(home, 'profiles', name), home }
}

/** The generated manifest of a profile directory. */
const manifestOf = (dir: string): ProfileManifest =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ProfileManifest

afterEach(() => { vi.unstubAllEnvs() })

describe('resolveInitTemplate', () => {
  it('prefers explicit layers, then the shipped template, then the base default', () => {
    expect(resolveInitTemplate('headless', [])).toEqual(PROFILE_TEMPLATES.headless)
    expect(resolveInitTemplate('web', [])).toEqual(PROFILE_TEMPLATES.web)
    expect(resolveInitTemplate('myagent', []))
      .toEqual({ bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' })
    // Explicit layers replace the list without changing a shipped name's lifecycle.
    expect(resolveInitTemplate('headless', ['@deepseek-ai/dsh-base']))
      .toEqual({ bundles: ['@deepseek-ai/dsh-base'], patchReload: 'startup' })
    expect(resolveInitTemplate('myagent', ['@deepseek-ai/dsh-headless']))
      .toEqual({ bundles: ['@deepseek-ai/dsh-headless'], patchReload: 'live' })
  })
})

describe('runInit', () => {
  it('writes every config file a boot needs for a name with no shipped template', () => {
    const { code, out, dir } = init('myagent')
    expect(code).toBe(0)
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(dir, 'bunfig.toml'))).toBe(true)
    expect(manifestOf(dir).dsh?.profile).toEqual({ bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' })
    expect(out).toContain('created')
    expect(out).toContain(dir)
    expect(out).toContain('dsh --profile myagent')
    // The generated patch layer is the empty list a boot composes over.
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('[]')
  })

  it('reproduces what a shipped profile\'s first boot would have created', () => {
    const { dir } = init('headless')
    expect(manifestOf(dir).dsh?.profile).toEqual(PROFILE_TEMPLATES.headless)
  })

  it('writes explicit --bundle layers in argv order', () => {
    const { out, dir } = init('mix', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    expect(manifestOf(dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    expect(out).toContain('@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless')
  })

  it('reruns without touching an existing profile, and says so when layers are passed', () => {
    const first = init('myagent')
    writeFileSync(join(first.dir, 'cordis.patch.yml'), '- id: mine\n')
    const again = init('myagent', ['@deepseek-ai/dsh-headless'], first.home)
    expect(again.code).toBe(0)
    expect(again.out).toContain('already exists')
    expect(again.out).toContain('--bundle was ignored')
    expect(manifestOf(again.dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(again.dir, 'cordis.patch.yml'), 'utf8')).toBe('- id: mine\n')
    // A silent rerun is the ordinary case: no notice without --bundle.
    expect(init('myagent', [], first.home).out).not.toContain('--bundle was ignored')
  })

  it('refuses a layer that cannot become one, writing nothing', () => {
    const home = tmpHome()
    expect(() => init('broken', ['@deepseek-ai/dsh-not-a-real-package'], home))
      .toThrow('cannot resolve profile bundle')
    // Resolvable, but a library: it exports no patch, so it is not a layer.
    expect(() => init('broken', ['@deepseek-ai/dsh-app-boot'], home))
      .toThrow('declares no dsh.bundle')
    expect(existsSync(join(home, 'profiles', 'broken'))).toBe(false)
  })

  it('rejects a profile name that is not a directory name', () => {
    expect(() => init('../escape')).toThrow('invalid profile name')
  })
})
