/**
 * TypeScript 7.0.2's package exports include the new compiler API under
 * `typescript/unstable/*`. This gate fails if the mandated `typescript`
 * pin stops exporting that API, and if the 6.0 Strada compatibility
 * package (`@typescript/typescript6`) re-enters any tracked manifest,
 * lockfile, or source.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { API } from 'typescript/unstable/sync'
import { SyntaxKind } from 'typescript/unstable/ast'
import { isFunctionDeclaration } from 'typescript/unstable/ast/is'
import { version, versionMajorMinor } from 'typescript'
import { describe, expect, it } from 'vitest'
import { closeCompiler, createSourceFile } from './ts7-session.ts'

const root = resolve(import.meta.dirname, '..')

describe('mandated typescript 7 compiler API', () => {
  it('is TypeScript 7 on the typescript package', () => {
    expect(versionMajorMinor).toBe('7.0')
    expect(version.startsWith('7.')).toBe(true)
  })

  it('exports the unstable sync API and AST SyntaxKind from typescript 7', () => {
    expect(API).toBeTypeOf('function')
    expect(SyntaxKind.ExportKeyword).toBeTypeOf('number')
  })

  it('parses a repository tsconfig through the TypeScript 7 sync API', () => {
    const api = new API()
    const parsed = api.parseConfigFile(`${import.meta.dirname}/../tsconfig.host.json`)
    api.close()
    expect(Array.isArray(parsed.fileNames)).toBe(true)
    expect(parsed.fileNames.length).toBeGreaterThan(0)
  })

  it('loads an on-disk source file through a snapshot inferred project', () => {
    const api = new API()
    const file = `${import.meta.dirname}/typescript7-unstable-api.spec.ts`
    const snapshot = api.updateSnapshot({ openFiles: [file] })
    const project = snapshot.getDefaultProjectForFile(file)
    const sourceFile = project?.program.getSourceFile(file)
    api.close()
    expect(project).not.toBeUndefined()
    expect(sourceFile?.fileName.endsWith('typescript7-unstable-api.spec.ts')).toBe(true)
    expect((sourceFile?.statements.length ?? 0) > 0).toBe(true)
  })

  it('parses in-memory TypeScript text through createSourceFile', () => {
    const sourceFile = createSourceFile('inline.ts', 'export function hello(): string { return "ok" }\n')
    const first = sourceFile.statements[0]
    closeCompiler()
    expect(first === undefined ? false : isFunctionDeclaration(first)).toBe(true)
  })

  it('keeps the 6.0 Strada compatibility package out of the tree', () => {
    const result = spawnSync('git', [
      'grep',
      '-l',
      '-e', 'from \'@typescript/typescript6\'',
      '-e', 'import(\'@typescript/typescript6\')',
      '-e', '"@typescript/typescript6":',
      '--',
      // The whole tracked tree, so the root manifest and `bun.lock` — where the
      // package would re-enter first — are covered. `goal/` holds plan records
      // of past runs, frozen like archived notes: one predates this decision and
      // states the opposite acceptance criterion.
      '.',
      ':(exclude)scripts/typescript7-unstable-api.spec.ts',
      ':(exclude)goal/',
    ], { cwd: root, encoding: 'utf8' })
    // git grep exits 1 when nothing matches: exactly the passing case.
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })
})
