import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { SyntaxKind } from 'typescript/unstable/ast'
import { isInterfaceDeclaration, isPropertySignatureDeclaration } from 'typescript/unstable/ast/is'
import { afterAll, expect, it } from 'vitest'
import { closeCompiler, createSourceFile } from './ts7-session.ts'

afterAll(closeCompiler)

it('installs the complete source-built compiler API for repository and generator consumers', () => {
  const manifest = fileURLToPath(import.meta.resolve('typescript/package.json'))
  const generator = createRequire(new URL('../packages/typert/generator/package.json', import.meta.url))
  expect(generator.resolve('typescript/package.json')).toBe(manifest)
  const root = dirname(manifest)
  const artifact = new URL('../tooling/typescript/artifacts/inventory.json', import.meta.url)
  const inventory: unknown = JSON.parse(readFileSync(artifact, 'utf8'))
  if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) {
    throw new Error('TypeScript artifact inventory must be a file-digest object')
  }
  const files = readdirSync(join(root, 'dist'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/')).sort()
  expect(Object.keys(inventory).sort()).toEqual(files)
  expect(files).toHaveLength(364)
  for (const file of files) {
    const expected: unknown = Reflect.get(inventory, file)
    expect(createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), file).toBe(expected)
  }
})

it('compiles absent annotation and initializer fields and executes the actual factory', async () => {
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
  const config = fileURLToPath(new URL('../tooling/typescript/tsconfig.json', import.meta.url))
  const contract = fileURLToPath(new URL('../tooling/typescript/contract.ts', import.meta.url))
  const compiled = await execa(process.execPath, [compiler, '-p', config, '--pretty', 'false'])
  expect(compiled.stdout).toBe('')
  expect(compiled.stderr).toBe('')
  const executed = await execa(process.execPath, [contract])
  expect(executed.stdout).toBe('')
  expect(executed.stderr).toBe('')
})

it('parses absent and present annotations independently of property optionality', () => {
  const source = createSourceFile('annotation.ts', 'interface Entry { missing; optional?; typed: string; typedOptional?: number }')
  const declaration = source.statements[0]
  if (declaration === undefined || !isInterfaceDeclaration(declaration)) throw new Error('Expected Entry interface')
  expect(declaration.members).toHaveLength(4)
  const members = declaration.members.map((member) => {
    if (!isPropertySignatureDeclaration(member)) throw new Error('Expected property signature')
    return {
      name: member.name.getText(source),
      annotation: member.type?.kind,
      optional: member.postfixToken?.kind,
      initializer: member.initializer,
    }
  })
  expect(members).toEqual([
    { name: 'missing', annotation: undefined, optional: undefined, initializer: undefined },
    { name: 'optional', annotation: undefined, optional: SyntaxKind.QuestionToken, initializer: undefined },
    { name: 'typed', annotation: SyntaxKind.StringKeyword, optional: undefined, initializer: undefined },
    { name: 'typedOptional', annotation: SyntaxKind.NumberKeyword, optional: SyntaxKind.QuestionToken, initializer: undefined },
  ])
})
