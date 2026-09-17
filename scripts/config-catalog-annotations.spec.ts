import { afterAll, expect, it } from 'vitest'
import { checkMemberDocs, findTypeDecl } from './gen-config-catalog-load.ts'
import { lookupPath, parseSchemaPath } from './gen-config-catalog-lookup.ts'
import type { FileCtx, World } from './gen-config-catalog-model.ts'
import { closeCompiler, createSourceFile } from './ts7-session.ts'

afterAll(closeCompiler)

it.each(['entry', 'entry?'])('checks documentation and nested paths for an unannotated %s property', (member) => {
  const text = `interface Config {
  ${member};
  /** Named value. */
  typed: { value: string }
}`
  const sf = createSourceFile('config.ts', text)
  const ctx: FileCtx = { abs: sf.fileName, rel: 'config.ts', text, sf, imports: new Map() }
  const world: World = { scanRoot: '.', cache: new Map([[ctx.abs, ctx]]), pkgDirByName: new Map() }
  const declaration = findTypeDecl(ctx, 'Config')
  if (declaration === null) throw new Error('Expected Config declaration')
  const violations: string[] = []
  checkMemberDocs(ctx, declaration, violations)
  expect(violations).toEqual([
    "config field 'Config.entry' (config.ts:2) has no JSDoc prose.",
    "config field 'Config.typed.value' (config.ts:4) has no JSDoc prose.",
  ])
  expect(lookupPath(world, ctx, declaration, parseSchemaPath('entry'), new Set())).toBe('found')
  expect(lookupPath(world, ctx, declaration, parseSchemaPath('entry.value'), new Set())).toBe('unknown')
  expect(lookupPath(world, ctx, declaration, parseSchemaPath('typed.value'), new Set())).toBe('found')
  expect(lookupPath(world, ctx, declaration, parseSchemaPath('typed.missing'), new Set())).toBe('missing')
})
