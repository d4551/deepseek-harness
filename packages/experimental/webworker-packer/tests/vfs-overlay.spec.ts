/**
 * Unit suites for preview overlay packing: no built output involved, so this
 * file stays in the default unit include. The built-image suites live in
 * tests/image-loadable.built.ts under vitest.built.config.ts.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { previewFixtures } from '../src/repository.ts'
import { packVfsOverlay } from '../src/pack.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

describe('preview example overlays', () => {
  it('packs source-looking paths and dot directories into a separate overlay', () => {
    const fixture = previewFixtures(repoRoot)[0]
    expect(fixture?.id).toBe('vfs-example')
    const result = packVfsOverlay(fixture?.trees ?? [])
    expect(new TextDecoder().decode(result.files['workspace/src/preview.ts']))
      .toContain("previewStatus = 'ready'")
    expect(new TextDecoder().decode(result.files['workspace/.agents/skills/preview-tour/SKILL.md']))
      .toContain('name: preview-tour')
    expect(Object.keys(result.files).filter(path => path.endsWith('/session.jsonl'))).toHaveLength(3)
  })

  it('fails loud when a declared seed tree is absent', () => {
    expect(() => packVfsOverlay([
      { mount: 'workspace', directory: join(repoRoot, 'missing-preview-seed') },
    ])).toThrow(/tree workspace is missing/)
  })

  it('refuses overlays that could replace runtime files', () => {
    const fixture = previewFixtures(repoRoot)[0]
    expect(() => packVfsOverlay([
      { mount: 'config', directory: fixture?.trees[0]?.directory ?? repoRoot },
    ])).toThrow(/must stay under home or workspace/)
  })
})
