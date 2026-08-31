/**
 * Red/green contract plus the live-tree sweep for the syntax-duplication gate
 * that replaced the sonarjs duplicate-shape rules (dropped for the TypeScript
 * 6 API requirement). Every rule proves it rejects an invalid case before the
 * clean-tree assertion counts for anything.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { syntaxDuplicationFindings, syntaxDuplicationFindingsForPaths } from './syntax-duplication.ts'

const root = resolve(import.meta.dirname, '..')

function rulesFor(text: string, file = 'probe.ts'): string[] {
  return syntaxDuplicationFindings([{ file, text }]).map(finding => finding.rule)
}

describe('syntax duplication findings', () => {
  it('rejects a duplicate character-class member and accepts distinct ones', () => {
    expect(rulesFor('export const r = /[aab]/u')).toEqual(['duplicate-character-class-member'])
    expect(rulesFor('export const r = /[\\d\\d]/u')).toEqual(['duplicate-character-class-member'])
    expect(rulesFor('export const r = /[abc]/u')).toEqual([])
    // A range is one member: `b` inside `a-c` is not a literal repeat.
    expect(rulesFor('export const r = /[a-cb]/u')).toEqual([])
    expect(rulesFor('export const r = /[a-cd-f]/u')).toEqual([])
  })

  it('rejects an if/else chain whose branches are all identical', () => {
    expect(rulesFor('export function p(x: number) { if (x > 0) { return 1 } else { return 1 } }'))
      .toEqual(['all-branches-identical'])
    expect(rulesFor('export function p(x: number) { if (x > 0) { return 1 } else { return 2 } }'))
      .toEqual([])
    // An open chain (no else) with distinct bodies is legal.
    expect(rulesFor('export function p(x: number) { if (x > 0) { return 1 } }')).toEqual([])
  })

  it('rejects one duplicated multi-statement branch in a chain and in a switch', () => {
    expect(rulesFor(
      'export function p(x: number) { if (x > 0) { x += 1; return x } else if (x > 1) { return 2 } else { x += 1; return x } }',
    )).toEqual(['duplicated-branch'])
    expect(rulesFor(
      'export function p(x: number) { switch (x) { case 1: { x += 1; break } case 2: { x += 1; break } default: return 3 } return x }',
    )).toEqual(['duplicated-branch'])
    // Single-statement branches are exempt — mapping tables are idiomatic —
    // matching the replaced rule's documented exception.
    expect(rulesFor(
      'export function p(x: number) { if (x > 0) { return 1 } else if (x > 1) { return 2 } else { return 1 } }',
    )).toEqual([])
    expect(rulesFor(
      'export function p(x: number) { switch (x) { case 1: return 1; case 2: return 1; default: return 3 } }',
    )).toEqual([])
    // Fallthrough clauses share one body by construction.
    expect(rulesFor(
      'export function p(x: number) { switch (x) { case 1: case 2: return 1; default: return 3 } }',
    )).toEqual([])
  })

  it('rejects a conditional expression whose results are identical', () => {
    expect(rulesFor('export const v = (x: number) => x > 0 ? 1 : 1')).toEqual(['all-branches-identical'])
    expect(rulesFor('export const v = (x: number) => x > 0 ? 1 : 2')).toEqual([])
  })

  it('rejects identical short-circuit operands', () => {
    expect(rulesFor('export const v = (a: boolean) => a && a')).toEqual(['identical-operands'])
    expect(rulesFor('export const v = (a?: number) => a ?? a')).toEqual(['identical-operands'])
    expect(rulesFor('export const v = (a: boolean, b: boolean) => a && b')).toEqual([])
    // Arithmetic self-pairing (x * x) is legitimate and out of scope.
    expect(rulesFor('export const v = (a: number) => a * a')).toEqual([])
  })

  it('rejects a duplicate test title within one describe scope only', () => {
    const spec = (body: string): string[] => rulesFor(body, 'probe.spec.ts')
    expect(spec("describe('a', () => { it('same', () => {}); it('same', () => {}) })"))
      .toEqual(['duplicate-test-title'])
    expect(spec("describe('a', () => { it('one', () => {}); it('two', () => {}) })")).toEqual([])
    // The same title under two different describes is two distinct scopes.
    expect(spec("describe('a', () => { it('same', () => {}) }); describe('b', () => { it('same', () => {}) })"))
      .toEqual([])
  })

  // A whole-tree parse through one compiler session; the budget mirrors the
  // Strada-API sweep's cost profile rather than the unit-case default.
  it('keeps the tracked tree free of syntax duplication', { timeout: 120_000 }, () => {
    const listed = spawnSync('git', [
      'ls-files', '--',
      'packages/**/*.ts', 'packages/**/*.tsx', 'scripts/*.ts', 'apps/**/*.ts',
      ':(exclude)packages/typert/generator/tests/fixtures/*',
      ':(exclude)packages/*/*/tests/fixtures/*',
    ], { cwd: root, encoding: 'utf8' })
    expect(listed.error).toBeUndefined()
    const files = listed.stdout.split('\n').filter(entry => entry !== '')
    expect(files.length).toBeGreaterThan(1500)
    expect(syntaxDuplicationFindingsForPaths(root, files)).toEqual([])
  })
})
