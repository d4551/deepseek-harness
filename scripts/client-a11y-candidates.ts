/** Source ownership of browser tests that request strict accessibility checks. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse } from '@babel/parser'
import traverse, { type NodePath } from '@babel/traverse'
import * as t from '@babel/types'

/** Definition range used to match a native Vitest test location. */
export interface AccessibilityTestDefinition {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

function rootIdentifier(node: t.Node): t.Identifier | undefined {
  if (t.isIdentifier(node)) return node
  if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) return rootIdentifier(node.object)
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) return rootIdentifier(node.callee)
  if (t.isTaggedTemplateExpression(node)) return rootIdentifier(node.tag)
  return undefined
}

function importedName(path: NodePath): string | undefined {
  if (!path.isImportSpecifier()) return undefined
  return t.isIdentifier(path.node.imported) ? path.node.imported.name : path.node.imported.value
}

function functionPath(path: NodePath): NodePath | undefined {
  if (path.isFunction()) return path
  if (path.isVariableDeclarator()) {
    const initializer = path.get('init')
    if (initializer.isFunction()) return initializer
  }
  return undefined
}

/**
 * Identify test definitions that call the strict failure checker, directly or through helpers.
 * Dead branches and skipped definitions remain obligations for the execution reporter.
 * @param file - absolute spec path, also the base for relative helper imports.
 * @param source - complete spec source.
 * @returns test definition ranges; this is a requirement inventory, not execution evidence.
 */
export function accessibilityTestDefinitions(file: string, source: string): AccessibilityTestDefinition[] {
  const programs = new Map<string, NodePath<t.Program>>()
  const load = (path: string, text = readFileSync(path, 'utf8')): NodePath<t.Program> => {
    const existing = programs.get(path)
    if (existing !== undefined) return existing
    const ast = parse(text, { sourceType: 'module', sourceFilename: path, plugins: ['typescript', 'jsx', 'decorators'] })
    let program: NodePath<t.Program> | undefined
    traverse(ast, { Program(value) { program = value; value.stop() } })
    if (program === undefined) throw new Error(`Accessibility source has no program: ${path}`)
    programs.set(path, program)
    return program
  }

  const callsCheck = (body: NodePath, owner: string, seen: Set<t.Node>): boolean => {
    if (seen.has(body.node)) return false
    seen.add(body.node)
    let found = false
    body.traverse({
      CallExpression(call) {
        const callee = call.get('callee')
        if (!callee.isIdentifier()) return
        const binding = call.scope.getBinding(callee.node.name)
        if (binding === undefined) return
        const declaration = binding.path
        const imported = importedName(declaration)
        const module = declaration.parentPath
        if (imported !== undefined && module.isImportDeclaration()) {
          if (module.node.source.value === '@deepseek-ai/dsh-client-a11y' && imported === 'accessibilityFailures') {
            found = true
          } else if (module.node.source.value.startsWith('.')) {
            const helperFile = resolve(dirname(owner), module.node.source.value)
            const helper = load(helperFile).scope.getBinding(imported)
            const fn = helper === undefined ? undefined : functionPath(helper.path)
            if (fn !== undefined) found = callsCheck(fn, helperFile, seen)
          }
        } else {
          const fn = functionPath(declaration)
          if (fn !== undefined) found = callsCheck(fn, owner, seen)
        }
        if (found) call.stop()
      },
    })
    return found
  }

  const definitions: AccessibilityTestDefinition[] = []
  const program = load(resolve(file), source)
  program.traverse({
    CallExpression(call) {
      const root = rootIdentifier(call.node.callee)
      if (root === undefined) return
      const binding = call.scope.getBinding(root.name)
      if (binding === undefined) return
      const name = importedName(binding.path)
      const module = binding.path.parentPath
      if ((name !== 'it' && name !== 'test') || !module.isImportDeclaration() || module.node.source.value !== 'vitest') return
      const callbacks = call.get('arguments').flatMap((argument) => {
        if (argument.isFunction()) return [argument]
        if (!argument.isIdentifier()) return []
        const callback = argument.scope.getBinding(argument.node.name)
        const fn = callback === undefined ? undefined : functionPath(callback.path)
        return fn === undefined ? [] : [fn]
      })
      if (!callbacks.some(callback => callsCheck(callback, resolve(file), new Set()))) return
      const location = call.node.loc
      if (location === null || location === undefined) throw new Error(`Accessibility test has no source location: ${file}`)
      definitions.push({
        startLine: location.start.line, startColumn: location.start.column + 1,
        endLine: location.end.line, endColumn: location.end.column + 1,
      })
    },
  })
  return definitions
}
