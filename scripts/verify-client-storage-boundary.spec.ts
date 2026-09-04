/** Client storage boundary gate: detector behavior and the live tree sweep. */

import { describe, expect, it } from 'vitest'
import {
  STORAGE_ALLOWLIST,
  checkStorageBoundary,
  clientSourceDirectories,
  collectCorpus,
  findStorageUsages,
} from './verify-client-storage-boundary.ts'

describe('findStorageUsages', () => {
  it('finds executing occurrences with their lines', () => {
    const source = [
      'const ready = typeof localStorage === "undefined"',
      'export const read = () => localStorage.getItem("k")',
    ].join('\n')
    const usages = findStorageUsages('client/x.ts', source)
    expect(usages.map(usage => usage.line)).toEqual([1, 2])
    expect(usages[1]?.text).toContain('localStorage.getItem')
  })

  it('ignores occurrences inside comments and string literals', () => {
    const source = [
      '// mentions localStorage in prose',
      '/* block comment: sessionStorage too */',
      'const doc = "references localStorage in a string"',
      'const template = `and ${"localStorage"} in a template`',
    ].join('\n')
    expect(findStorageUsages('client/x.ts', source)).toEqual([])
  })

  it('counts every occurrence in one line', () => {
    const source = 'const pair = [localStorage, sessionStorage]'
    expect(findStorageUsages('client/x.ts', source)).toHaveLength(2)
  })
})

describe('checkStorageBoundary', () => {
  const allowedSource = (occurrences: number): string => {
    const lines: string[] = []
    for (let index = 0; index < occurrences; index++) lines.push(`export const touch${String(index)} = localStorage`)
    return lines.join('\n')
  }
  const allowlist = [{ path: 'client/allowed.ts', occurrences: 2, reason: 'reviewed seam' }]
  const corpus = (paths: string[]): { path: string; text: string }[] =>
    paths.map(path => ({ path, text: path === 'client/allowed.ts' ? allowedSource(2) : 'export const clean = 1' }))
  const floor = { minimumFiles: 3 }

  it('passes an allowlisted file at its pinned count', () => {
    const files = corpus(['client/allowed.ts', 'client/a.ts', 'client/b.ts'])
    expect(checkStorageBoundary(files, allowlist, floor.minimumFiles)).toEqual([])
  })

  it('fails an unreviewed file with its line', () => {
    const files = [
      { path: 'client/allowed.ts', text: allowedSource(2) },
      { path: 'client/stray.ts', text: 'sessionStorage.setItem("k", "v")' },
      { path: 'client/b.ts', text: 'export const clean = 1' },
    ]
    const violations = checkStorageBoundary(files, allowlist, floor.minimumFiles)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ path: 'client/stray.ts', line: 1 })
    expect(violations[0]?.detail).toContain('unreviewed')
  })

  it('fails an allowlisted file whose occurrence count drifted', () => {
    const files = [
      { path: 'client/allowed.ts', text: allowedSource(3) },
      { path: 'client/a.ts', text: 'export const clean = 1' },
      { path: 'client/b.ts', text: 'export const clean = 1' },
    ]
    const violations = checkStorageBoundary(files, allowlist, floor.minimumFiles)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.detail).toContain('count drifted')
  })

  it('fails an allowlisted file that left the corpus', () => {
    const violations = checkStorageBoundary(corpus(['client/a.ts', 'client/b.ts']), allowlist, 2)
    expect(violations.some(violation => violation.detail.includes('left the corpus'))).toBe(true)
  })

  it('fails a corpus below the floor instead of passing a narrowed walk', () => {
    const violations = checkStorageBoundary(corpus(['client/a.ts']), allowlist, 3)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.path).toBe('(corpus)')
  })
})

describe('live client tree', () => {
  it('keeps every client source inside the reviewed storage boundary', () => {
    const directories = clientSourceDirectories()
    expect(directories.length).toBeGreaterThan(5)
    const files = directories.flatMap(directory => collectCorpus(directory))
    expect(files.length).toBeGreaterThanOrEqual(50)
    const violations = checkStorageBoundary(files, STORAGE_ALLOWLIST, 50)
    expect(violations).toEqual([])
  })
})
