/**
 * Compiler/linter softening detectors fail injected misses; the live
 * tsconfig.base.json must keep skipLibCheck off.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  oxlintSofteningHits,
  skipLibCheckHits,
} from './compiler-softenings.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('injected compiler softenings', () => {
  it('fails skipLibCheck true', () => {
    expect(skipLibCheckHits('tsconfig.base.json', '{"compilerOptions":{"skipLibCheck":true}}'))
      .toEqual([{ file: 'tsconfig.base.json' }])
  })

  it('accepts skipLibCheck false', () => {
    expect(skipLibCheckHits('tsconfig.base.json', '{"compilerOptions":{"skipLibCheck":false}}'))
      .toEqual([])
  })

  it('fails empty oxlint plugins and correctness allow', () => {
    expect(oxlintSofteningHits('.oxlintrc.json', '{"plugins":[],"categories":{"correctness":"allow"}}'))
      .toEqual([
        '.oxlintrc.json: empty plugins',
        '.oxlintrc.json: missing plugin eslint',
        '.oxlintrc.json: missing plugin typescript',
        '.oxlintrc.json: missing plugin unicorn',
        '.oxlintrc.json: missing plugin oxc',
        '.oxlintrc.json: missing plugin jsx-a11y',
        '.oxlintrc.json: correctness allow',
      ])
  })

  it('fails a nonempty plugin list that omits a default plugin', () => {
    expect(oxlintSofteningHits(
      '.oxlintrc.json',
      '{"plugins":["eslint","typescript","oxc","jsx-a11y"],"categories":{"correctness":"error"}}',
    )).toEqual(['.oxlintrc.json: missing plugin unicorn'])
  })

  it('fails an omitted plugins field', () => {
    expect(oxlintSofteningHits('.oxlintrc.json', '{"categories":{"correctness":"error"}}'))
      .toEqual(['.oxlintrc.json: plugins missing'])
  })
})

describe('live compiler configuration', () => {
  it('keeps skipLibCheck off in the shared Host/Client and landlock bases', () => {
    const files = ['tsconfig.base.json', 'native/landlock-run/tsconfig.base.json']
    expect(files.flatMap(file => skipLibCheckHits(file, readFileSync(join(root, file), 'utf8')))).toEqual([])
  })

  it('keeps oxlint plugins populated and correctness enforced', () => {
    expect(oxlintSofteningHits('.oxlintrc.json', readFileSync(join(root, '.oxlintrc.json'), 'utf8'))).toEqual([])
  })
})
