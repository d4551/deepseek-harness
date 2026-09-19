import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse, type ParserPlugin } from '@babel/parser'
import traverse from '@babel/traverse'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

it('keeps browser source independent of disposal symbols required by using declarations', () => {
  const files = globSync('packages/client/*/src/**/*.{ts,tsx}', { cwd: root })
  expect(files.length).toBeGreaterThan(0)
  expect(files).toContain('packages/client/ui-renderer/src/client/registry.ts')
  expect(files).toContain('packages/client/connection/src/client/connection.ts')
  const declarations: string[] = []
  for (const file of files) {
    const plugins: ParserPlugin[] = ['typescript', 'decorators']
    if (file.endsWith('.tsx')) plugins.push('jsx')
    const ast = parse(readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8'), {
      sourceType: 'module',
      sourceFilename: file,
      plugins,
    })
    traverse(ast, {
      VariableDeclaration({ node }) {
        if (node.kind === 'using' || node.kind === 'await using') {
          declarations.push(`${file}:${String(node.loc?.start.line)}: ${node.kind}`)
        }
      },
    })
  }
  expect(declarations).toEqual([])
})
