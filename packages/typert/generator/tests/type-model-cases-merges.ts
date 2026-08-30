/**
 * Shared type-model case bodies for declaration merges. Registered by
 * type-model.spec.ts; the split type-model-*.spec.ts files register the
 * same functions.
 */

import { expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { copyFixture } from './type-model-helpers.ts'

export function retainsEveryMergedInterfacePart(): void {
  const root = copyFixture('typert-merged-declaration-')
  const sourcePath = join(root, 'packages/host/src/models.ts')
  writeFileSync(sourcePath, [
    readFileSync(sourcePath, 'utf8'),
    '/** @typert object */',
    'export interface Merged<Value extends Entity = Entity> extends Entity { readonly left: Value }',
    'export interface Merged<Value extends Entity = Entity> { readonly right: Value }',
    '/** @typert object */',
    'export interface MergedInput<in Value> { consume(value: Value): boolean }',
    'export interface MergedInput<Value> { consumeAgain(value: Value): boolean }',
    '',
  ].join('\n'))

  const model = new WorkspaceAnalyzer({ root }).analyze()
  const merged = model.faces
    .flatMap(face => face.graph.declarations)
    .find(declaration => declaration.name === 'Merged')
  expect(merged?.members.map(member => member.name)).toEqual(['left', 'right'])
  expect(merged?.parts?.map(part => part.members.length)).toEqual([1, 1])
  expect(merged?.parts?.map(part => part.typeParameters.length)).toEqual([1, 1])
  expect(merged?.parts?.map(part => part.extends.length)).toEqual([1, 0])
  expect(merged?.parts?.map(part => part.package)).toEqual(['@fixture/host', '@fixture/host'])
  const mergedInput = model.faces
    .flatMap(face => face.graph.declarations)
    .find(declaration => declaration.name === 'MergedInput')
  expect(mergedInput?.typeParameters[0]?.variance).toBe('in')
}

export function rejectsMergedDeclarationsOutsideFace(): void {
  const root = copyFixture('typert-external-merge-')
  writeFileSync(join(root, 'external-augmentation.ts'), [
    'export {}',
    'declare global {',
    '  interface ExternalMerged { readonly augmented?: string }',
    '}',
    '',
  ].join('\n'))
  const modelsPath = join(root, 'packages/host/src/models.ts')
  writeFileSync(modelsPath, [
    readFileSync(modelsPath, 'utf8'),
    'declare global {',
    '  interface ExternalMerged { readonly local?: string }',
    '}',
    'export interface SyntaxZoo { readonly externalMerged: ExternalMerged }',
    '',
  ].join('\n'))
  const sourcePath = join(root, 'packages/host/src/index.ts')
  writeFileSync(sourcePath, [
    readFileSync(sourcePath, 'utf8'),
    "import '../../../external-augmentation.ts'",
  ].join('\n'))

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    'merged interface ExternalMerged contains a declaration outside this face',
  )
}

export function rejectsDeclarationMergesWithoutLosslessModel(): void {
  const root = copyFixture('typert-merged-enum-')
  const sourcePath = join(root, 'packages/host/src/models.ts')
  writeFileSync(sourcePath, [
    readFileSync(sourcePath, 'utf8'),
    '/** @typert schema */',
    "export enum MergedEnum { Left = 'left' }",
    "export enum MergedEnum { Right = 'right' }",
    '',
  ].join('\n'))

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    'merged EnumDeclaration declaration MergedEnum is not supported',
  )
}

export function rejectsConflictingMergedVariance(): void {
  const root = copyFixture('typert-merged-variance-')
  const sourcePath = join(root, 'packages/host/src/models.ts')
  writeFileSync(sourcePath, [
    readFileSync(sourcePath, 'utf8'),
    '/** @typert object */',
    'export interface MergedVariance<in Value> { consume(value: Value): void }',
    'export interface MergedVariance<out Value> { produce(): Value }',
    '',
  ].join('\n'))

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    'merged interface MergedVariance has incompatible variance modifiers',
  )
}

export function retainsPlainMergedInterfaces(): void {
  const root = copyFixture('typert-plain-merged-interface-')
  const sourcePath = join(root, 'packages/host/src/models.ts')
  writeFileSync(sourcePath, [
    readFileSync(sourcePath, 'utf8'),
    '/** @typert object */',
    'export interface PlainMerged<Value> { left: Value }',
    'export interface PlainMerged<Value> { right: Value }',
    '',
  ].join('\n'))

  const declaration = new WorkspaceAnalyzer({ root }).analyze().faces
    .flatMap(face => face.graph.declarations)
    .find(item => item.name === 'PlainMerged')
  expect(declaration?.typeParameters).toEqual([
    expect.objectContaining({ name: 'Value', const: false }),
  ])
  expect(declaration?.typeParameters[0]).not.toHaveProperty('constraint')
  expect(declaration?.typeParameters[0]).not.toHaveProperty('default')
}
