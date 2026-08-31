import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLIENT_TITLE,
  projectDocumentTitle,
  projectManifestTitle,
} from './client-document-title.ts'

const root = resolve(import.meta.dirname, '..')
const committedIndex = readFileSync(resolve(root, 'apps/web/index.html'), 'utf8')
const committedManifest = readFileSync(resolve(root, 'apps/web/public/manifest.webmanifest'), 'utf8')

describe('projectDocumentTitle', () => {
  it('leaves the committed document unchanged for the local-build title', () => {
    expect(projectDocumentTitle(committedIndex, DEFAULT_CLIENT_TITLE)).toBe(committedIndex)
  })

  it('projects the official title into the committed document', () => {
    expect(projectDocumentTitle(committedIndex, 'DeepSeek Harness')).toContain('<title>DeepSeek Harness</title>')
  })

  it('escapes HTML syntax in the title', () => {
    expect(projectDocumentTitle('<title>DeepMeow</title>', 'A & <b>')).toBe('<title>A &amp; &lt;b&gt;</title>')
  })

  it('keeps replacement patterns in the title literal', () => {
    expect(projectDocumentTitle('<title>DeepMeow</title>', '$1 $`')).toBe('<title>$1 $`</title>')
  })

  it('rejects a document that lost its placeholder title', () => {
    expect(() => projectDocumentTitle('<title>Other</title>', 'DeepSeek Harness')).toThrow(/lost its/)
  })
})

describe('projectManifestTitle', () => {
  it('leaves the committed manifest unchanged for the local-build title', () => {
    expect(projectManifestTitle(committedManifest, DEFAULT_CLIENT_TITLE)).toBe(committedManifest)
  })

  it('projects the official title into every title member', () => {
    const projected: unknown = JSON.parse(projectManifestTitle(committedManifest, 'DeepSeek Harness'))
    expect(projected).toMatchObject({
      name: 'DeepSeek Harness',
      short_name: 'DSH',
      description: 'DeepSeek Harness',
    })
  })

  it('carries a non-official title into the launcher label unabbreviated', () => {
    const projected: unknown = JSON.parse(projectManifestTitle(committedManifest, 'Fork Build'))
    expect(projected).toMatchObject({ name: 'Fork Build', short_name: 'Fork Build', description: 'Fork Build' })
  })

  it('JSON-encodes a title carrying quotes and backslashes', () => {
    const projected: unknown = JSON.parse(projectManifestTitle(committedManifest, 'a "b" \\ c'))
    expect(projected).toMatchObject({ name: 'a "b" \\ c' })
  })

  it('keeps replacement patterns in the title literal', () => {
    const projected: unknown = JSON.parse(projectManifestTitle(committedManifest, '$& $1'))
    expect(projected).toMatchObject({ name: '$& $1' })
  })

  it.each(['name', 'short_name', 'description'])('rejects a manifest that lost its %s placeholder', (member) => {
    const damaged = committedManifest.replace(`"${member}": "${DEFAULT_CLIENT_TITLE}"`, `"${member}": "Other"`)
    expect(() => projectManifestTitle(damaged, 'DeepSeek Harness')).toThrow(new RegExp(`lost its .*${member}`))
  })
})
