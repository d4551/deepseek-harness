import { globSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'

/** The accessibility harness whose value import routes a client spec to the browser lane. */
const A11Y_HARNESS = '@deepseek-ai/dsh-client-a11y'

/** Discover browser test files, retaining matching files inside artifact directories. */
export function discoverClientBrowserTests(root: string): string[] {
  return globSync('packages/*/*/tests/**/*.{client,browser}.spec.{ts,tsx}', { cwd: root, withFileTypes: true })
  .filter(entry => entry.isFile() || (entry.isSymbolicLink() && statSync(join(entry.parentPath, entry.name)).isFile()))
  .map(entry => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
  .filter((file) => {
    if (/\.browser\.spec\.tsx?$/.test(file)) return true
    const source = readFileSync(join(root, file), 'utf8')
    // A spec that never spells the harness specifier cannot import it, and
    // every config load pays for this discovery; only a mention earns the
    // parse that tells a value import from a type import or a comment.
    if (!source.includes(A11Y_HARNESS)) return false
    const plugins: ParserPlugin[] = ['typescript', 'decorators']
    if (file.endsWith('.tsx')) plugins.push('jsx')
    const program = parse(source, {
      sourceFilename: file,
      sourceType: 'module',
      plugins,
    })
    return program.program.body.some(node => node.type === 'ImportDeclaration'
      && node.importKind !== 'type'
      && node.source.value === A11Y_HARNESS)
  })
  .sort()
}

/** Client accessibility suites execute with native layout and pseudo-elements. */
export const clientBrowserTests = discoverClientBrowserTests(process.cwd())
