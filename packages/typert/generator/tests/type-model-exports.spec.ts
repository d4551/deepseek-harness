/**
 * Package.json export forms accepted or skipped by WorkspaceAnalyzer.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { copyFixture, readObject, temporaryRoots, writeObject } from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostManifest(root: string): { path: string; value: object } {
  const path = join(root, 'packages/host/package.json')
  return { path, value: readObject(path) }
}

describe('WorkspaceAnalyzer package export forms', { timeout: 60_000 }, () => {
  it('indexes array, fallback, and direct package export forms', () => {
    const root = copyFixture('typert-export-forms-')
    const hostRoot = join(root, 'packages/host')
    writeFileSync(join(hostRoot, 'src/runtime.ts'), 'export interface RuntimeOnly { value: string }\n')
    writeFileSync(join(hostRoot, 'src/direct.ts'), 'export interface Direct { value: string }\n')
    writeFileSync(join(hostRoot, 'src/empty.ts'), '\n')
    const { path, value } = hostManifest(root)
    Reflect.set(value, 'exports', {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './models': { types: './lib/types/models.d.ts', default: './lib/models.js' },
      './array': [null, { browser: './lib/runtime.js' }],
      './fallback': { browser: null, development: './lib/runtime.js' },
      './direct': './src/direct.ts',
      './empty': { types: './lib/types/empty.d.ts' },
      './none': [null, false],
      './empty-conditions': {},
      './package.json': './package.json',
      './typert': './lib/typert.host.js',
      './client/typert': './lib/typert.client.js',
      './wildcard': './lib/*.js',
      './data': './lib/data.json',
      ignored: './lib/index.js',
    })
    writeObject(path, value)
    const exports = new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')?.packages[0]?.exports ?? []
    expect(exports.some(item => item.subpath === './array' && item.name === 'RuntimeOnly')).toBe(true)
    expect(exports.some(item => item.subpath === './fallback' && item.name === 'RuntimeOnly')).toBe(true)
    expect(exports.some(item => item.subpath === './direct' && item.name === 'Direct')).toBe(true)
    expect(exports.some(item => item.subpath === './empty')).toBe(false)
  })

  it('accepts a string exports field', () => {
    const root = copyFixture('typert-export-string-')
    const { path, value } = hostManifest(root)
    Reflect.set(value, 'exports', './lib/index.js')
    writeObject(path, value)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces[0]?.packages[0]?.exports.length).toBeGreaterThan(0)
  })

  it('accepts a condition-object exports field', () => {
    const root = copyFixture('typert-export-conditions-')
    const { path, value } = hostManifest(root)
    Reflect.set(value, 'exports', { types: './lib/types/index.d.ts', default: './lib/index.js' })
    writeObject(path, value)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces[0]?.packages[0]?.exports.length).toBeGreaterThan(0)
  })

  it('accepts an array exports field', () => {
    const root = copyFixture('typert-export-array-')
    const { path, value } = hostManifest(root)
    Reflect.set(value, 'exports', [null, './lib/index.js'])
    writeObject(path, value)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces[0]?.packages[0]?.exports.length).toBeGreaterThan(0)
  })

  it('skips a package whose exports object is empty', () => {
    const root = copyFixture('typert-export-empty-')
    const { path, value } = hostManifest(root)
    Reflect.set(value, 'exports', {})
    writeObject(path, value)
    expect(new WorkspaceAnalyzer({ root, packages: ['@fixture/host'] }).analyze().faces.flatMap(face => face.packages))
      .toEqual([])
  })

  it('accepts a types field when exports is absent', () => {
    const root = copyFixture('typert-export-types-field-')
    const { path, value } = hostManifest(root)
    Reflect.deleteProperty(value, 'exports')
    Reflect.set(value, 'types', './lib/types/index.d.ts')
    writeObject(path, value)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces[0]?.packages[0]?.exports.length).toBeGreaterThan(0)
  })

  it('skips a package with neither exports nor types', () => {
    const root = copyFixture('typert-export-none-')
    const { path, value } = hostManifest(root)
    Reflect.deleteProperty(value, 'exports')
    Reflect.deleteProperty(value, 'types')
    writeObject(path, value)
    expect(new WorkspaceAnalyzer({ root, packages: ['@fixture/host'] }).analyze().faces.flatMap(face => face.packages))
      .toEqual([])
  })
})
