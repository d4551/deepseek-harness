/**
 * Compiler/linter softening detectors fail injected misses; the live
 * tsconfig bases must keep first-party strict flags on.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  compilerSofteningHits,
  oxlintSofteningHits,
} from './compiler-softenings.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

const STRICT_TRUE = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
}

describe('injected compiler softenings', () => {
  it('accepts first-party strict flags', () => {
    expect(compilerSofteningHits(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: STRICT_TRUE }),
    )).toEqual([])
  })

  it('fails strict false', () => {
    expect(compilerSofteningHits(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { ...STRICT_TRUE, strict: false } }),
    )).toEqual([{ file: 'tsconfig.base.json', option: 'strict' }])
  })

  it('fails noUncheckedIndexedAccess false', () => {
    expect(compilerSofteningHits(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { ...STRICT_TRUE, noUncheckedIndexedAccess: false } }),
    )).toEqual([{ file: 'tsconfig.base.json', option: 'noUncheckedIndexedAccess' }])
  })

  it('fails exactOptionalPropertyTypes false', () => {
    expect(compilerSofteningHits(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { ...STRICT_TRUE, exactOptionalPropertyTypes: false } }),
    )).toEqual([{ file: 'tsconfig.base.json', option: 'exactOptionalPropertyTypes' }])
  })

  it('fails noImplicitOverride false', () => {
    expect(compilerSofteningHits(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { ...STRICT_TRUE, noImplicitOverride: false } }),
    )).toEqual([{ file: 'tsconfig.base.json', option: 'noImplicitOverride' }])
  })

  it('fails missing first-party strict flags', () => {
    expect(compilerSofteningHits('tsconfig.base.json', '{"compilerOptions":{}}')).toEqual([
      { file: 'tsconfig.base.json', option: 'strict' },
      { file: 'tsconfig.base.json', option: 'noUncheckedIndexedAccess' },
      { file: 'tsconfig.base.json', option: 'exactOptionalPropertyTypes' },
      { file: 'tsconfig.base.json', option: 'noImplicitOverride' },
    ])
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
  it('keeps first-party strict flags on in the shared Host/Client and landlock bases', () => {
    const files = ['tsconfig.base.json', 'native/landlock-run/tsconfig.base.json']
    expect(files.flatMap(file => compilerSofteningHits(file, readFileSync(join(root, file), 'utf8')))).toEqual([])
  })

  it('keeps oxlint plugins populated and correctness enforced', () => {
    expect(oxlintSofteningHits('.oxlintrc.json', readFileSync(join(root, '.oxlintrc.json'), 'utf8'))).toEqual([])
  })
})
