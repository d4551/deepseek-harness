import { transformSync } from '@babel/core'
import decorators from '@babel/plugin-proposal-decorators'
import syntaxJsx from '@babel/plugin-syntax-jsx'
import presetTypescript from '@babel/preset-typescript'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Worker arguments that keep process-wide Web Storage from shadowing jsdom storage.
 * Node lists the positive spelling in `allowedNodeEnvironmentFlags` for this negatable flag.
 */
export const vitestExecArgv = process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : []

/**
 * Transform standard TypeScript decorators before Vite's default parser sees source files.
 * @returns a pre-transform Vite plugin shared by source-mode test configurations.
 */
export function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0] ?? id
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      // oxc-transform 0.147 cannot lower stage-3 decorators (legacy only);
      // Babel's proposal-decorators at 2023-11 matches the semantics tsc emits.
      const result = transformSync(code, {
        filename: file,
        sourceMaps: true,
        babelrc: false,
        configFile: false,
        presets: [presetTypescript],
        plugins: [[decorators, { version: '2023-11' }], syntaxJsx],
      })
      if (result === null) return
      return {
        code: result.code
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2',
          ),
        map: result.map ?? undefined,
      }
    },
  }
}
