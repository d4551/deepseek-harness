import { globSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'

/** Discover browser test files, retaining matching files inside artifact directories. */
export function discoverClientBrowserTests(root: string): string[] {
  return globSync('packages/*/*/tests/**/*.{client,browser}.spec.{ts,tsx}', { cwd: root, withFileTypes: true })
  .filter(entry => entry.isFile() || (entry.isSymbolicLink() && statSync(join(entry.parentPath, entry.name)).isFile()))
  .map(entry => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
  .filter((file) => {
    if (/\.browser\.spec\.tsx?$/.test(file)) return true
    const plugins: ParserPlugin[] = ['typescript', 'decorators']
    if (file.endsWith('.tsx')) plugins.push('jsx')
    const source = parse(readFileSync(join(root, file), 'utf8'), {
      sourceFilename: file,
      sourceType: 'module',
      plugins,
    })
    return source.program.body.some(node => node.type === 'ImportDeclaration'
      && node.importKind !== 'type'
      && node.source.value === '@deepseek-ai/dsh-client-a11y')
  })
  .sort()
}

/** Client accessibility suites execute with native layout and pseudo-elements. */
export const clientBrowserTests = discoverClientBrowserTests(process.cwd())
