import { globSync, readFileSync } from 'node:fs'
import { parse, type ParserPlugin } from '@babel/parser'

/** Client accessibility suites execute with native layout and pseudo-elements. */
export const clientBrowserTests = globSync('packages/*/*/tests/**/*.{client,browser}.spec.{ts,tsx}')
  .map(file => file.replaceAll('\\', '/'))
  .filter((file) => {
    if (/\.browser\.spec\.tsx?$/.test(file)) return true
    const plugins: ParserPlugin[] = ['typescript', 'decorators']
    if (file.endsWith('.tsx')) plugins.push('jsx')
    const source = parse(readFileSync(file, 'utf8'), {
      sourceFilename: file,
      sourceType: 'module',
      plugins,
    })
    return source.program.body.some(node => node.type === 'ImportDeclaration'
      && node.importKind !== 'type'
      && node.source.value === '@deepseek-ai/dsh-client-a11y')
  })
  .sort()
