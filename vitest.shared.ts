import { transformSync } from 'oxc-transform'

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
      const result = transformSync(file, code, {
        sourcemap: true,
        decorator: { legacy: false },
        ...(file.endsWith('x') ? { jsx: { runtime: 'automatic' as const } } : {}),
      })
      const fatal = result.errors.filter(error => error.severity === 'Error')
      if (fatal.length > 0) {
        throw new Error(fatal.map(error => error.message).join('\n'))
      }
      return {
        code: result.code
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2',
          )
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.map,
      }
    },
  }
}
