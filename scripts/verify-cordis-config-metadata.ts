/**
 * Loader-entry metadata expression checks for {@link ./verify-cordis-config.ts}.
 */

import { isJsExpr, type CordisObject, type CordisValue } from './cordis-yaml.ts'
import { createSourceFile, syntacticDiagnostics } from './ts7-session.ts'

const metadataFields = ['id', 'name', 'group', 'inject', 'intercept', 'isolate'] as const

function collectExpressionPaths(
  value: CordisValue,
  path: string,
  output: string[],
) {
  if (isJsExpr(value)) {
    output.push(path)
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const child = value[index]
      collectExpressionPaths(
        child === undefined ? null : child,
        `${path}[${index}]`,
        output,
      )
    }
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    collectExpressionPaths(
      child === undefined ? null : child,
      `${path}.${key}`,
      output,
    )
  }
}

/**
 * Parse-only validation of a `disabled` expression: the Loader evaluates it
 * at every mount decision, and a syntax error would fail the boot — rejecting
 * it here moves that failure to the earliest resolvable point.
 * @param expression - the `!!js` expression text.
 * @returns the diagnostic suffix, or `undefined` when the expression parses.
 */
export function disabledExpressionProblem(expression: string): string | undefined {
  const sourceFile = createSourceFile('disabled-expr.ts', `const __dshDisabled = (${expression})\n`)
  const diagnostics = syntacticDiagnostics(sourceFile.fileName)
  const first = diagnostics[0]
  if (first === undefined) return undefined
  return `: disabled expression does not parse: ${first}`
}

/**
 * Expression-node diagnostics for one entry. `disabled` is the single
 * interpolated metadata field: its own `!!js` expression node is allowed and
 * must parse, while expressions nested below it stay truthy data; every other
 * metadata field must stay fully static.
 * @param entry - one loader entry (or patch row).
 * @param path - the entry's diagnostic path prefix.
 * @returns one diagnostic per offending expression.
 */
export function metadataExpressionErrors(entry: CordisObject, path: string): string[] {
  const problems: string[] = []
  for (const field of metadataFields) {
    if (!Object.hasOwn(entry, field)) continue
    const value = entry[field]
    const expressionPaths: string[] = []
    collectExpressionPaths(value ?? null, `${path}.${field}`, expressionPaths)
    for (const expressionPath of expressionPaths) problems.push(`${expressionPath}: !!js is not interpolated here`)
  }
  if (!Object.hasOwn(entry, 'disabled')) return problems
  const disabled = entry.disabled
  if (isJsExpr(disabled)) {
    const detail = disabledExpressionProblem(disabled.__jsExpr)
    if (detail !== undefined) problems.push(`${path}.disabled${detail}`)
    return problems
  }
  const expressionPaths: string[] = []
  collectExpressionPaths(disabled ?? null, `${path}.disabled`, expressionPaths)
  for (const expressionPath of expressionPaths) problems.push(`${expressionPath}: !!js is not interpolated here`)
  return problems
}
