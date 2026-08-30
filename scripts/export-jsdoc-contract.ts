/**
 * Shared node predicates and the per-declaration JSDoc contract for the
 * exported-API gate ({@link ./verify-export-jsdoc.ts}).
 *
 * Node and source types come from TypeScript 7 `unstable/ast`; the walk state
 * carries the program's `Checker` for the semantic queries the class-member
 * contract needs.
 */

import type {
  CallSignatureDeclaration, ClassDeclaration, ClassElement, Expression, FunctionTypeNode, MethodDeclaration, Node,
  ParameterDeclaration, SourceFile, TypeNode,
} from 'typescript/unstable/ast'
import { ModifierFlags } from 'typescript/unstable/ast'
import {
  isAsExpression,
  isCallSignatureDeclaration,
  isClassDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isConstructSignatureDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isFunctionTypeNode,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isModuleDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPrivateIdentifier,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeLiteralNode,
} from 'typescript/unstable/ast/is'
import { TypeFlags, type Checker, type Type } from 'typescript/unstable/sync'
import {
  checkParams, checkReturns, isThisParameter, parseJsDoc, parseTags, pointer, rawJsDoc, type JsDocParameter,
} from './jsdoc.ts'

/** Plugin-protocol slot names exempt as statics on an exported class. */
const PROTOCOL_STATICS = new Set(['Config', 'inject', 'name', 'reusable'])

/** Plugin-protocol slot names exempt as top-level exports (const or function). */
export const PROTOCOL_EXPORTS = new Set(['Config', 'inject', 'name', 'reusable', 'apply'])

/** Per-file walk state threaded through the scope recursion. */
export interface Walk {
  rel: string
  sf: SourceFile
  text: string
  checker: Checker
  violations: string[]
}

/** Whether a node carries one syntactic modifier flag. */
export function hasModifierFlag(node: Node, flag: ModifierFlags): boolean {
  if (!('modifierFlags' in node)) return false
  const flags = node.modifierFlags
  return typeof flags === 'number' && (flags & flag) !== 0
}

function classMemberName(member: ClassElement): Node | undefined {
  if (isMethodDeclaration(member) || isPropertyDeclaration(member)
    || isGetAccessorDeclaration(member) || isSetAccessorDeclaration(member)) {
    return member.name
  }
  return undefined
}

/** Whether a class member is private, protected, or `#`-named. */
function isNonPublic(member: ClassElement): boolean {
  const name = classMemberName(member)
  return hasModifierFlag(member, ModifierFlags.Private) || hasModifierFlag(member, ModifierFlags.Protected)
    || (name !== undefined && isPrivateIdentifier(name))
}

/** Whether a class member is static. */
function isStatic(member: ClassElement): boolean {
  return hasModifierFlag(member, ModifierFlags.Static)
}

/** Whether a resolved declaration is protected (a base member a public override replaces). */
function isProtectedDeclaration(d: Node): boolean {
  return hasModifierFlag(d, ModifierFlags.Protected)
}

/**
 * Peel expressions that define no API of their own — parentheses, `as` /
 * `satisfies` / angle-bracket casts, non-null assertions — so a wrapped
 * function expression is still classified as function-like.
 * @param e - the expression to unwrap.
 * @returns the innermost expression.
 */
export function unwrapExpression(e: Expression): Expression {
  let inner = e
  while (
    isParenthesizedExpression(inner) || isAsExpression(inner) || isSatisfiesExpression(inner)
    || isNonNullExpression(inner) || isTypeAssertion(inner)
  ) inner = inner.expression
  return inner
}

/**
 * Classify inline callable annotations. Mixed callable literals fail closed;
 * other annotations are ordinary value types.
 * @param type - the declarator's type annotation.
 * @returns the signature to check, 'refuse' for an unclassifiable callable literal, or null for a non-callable type.
 */
export function callableAnnotation(type: TypeNode): FunctionTypeNode | CallSignatureDeclaration | 'refuse' | null {
  if (isFunctionTypeNode(type)) return type
  if (!isTypeLiteralNode(type)) return null
  const signatures = type.members.filter(m => isCallSignatureDeclaration(m) || isConstructSignatureDeclaration(m))
  if (signatures.length === 0) return null
  if (signatures.length === 1 && type.members.length === 1 && signatures[0] !== undefined && isCallSignatureDeclaration(signatures[0])) {
    return signatures[0]
  }
  return 'refuse'
}

/**
 * Check description-prose presence for one labeled declaration: JSDoc must
 * exist and carry prose above its block tags.
 * @param where - the offender label violations open with.
 * @param raw - the declaration's raw JSDoc block ('' if none).
 * @param w - the walk state violations append to.
 */
export function checkDescribed(where: string, raw: string, w: Walk) {
  if (!raw) w.violations.push(`${where} has no JSDoc.`)
  else if (!parseJsDoc(raw).doc) w.violations.push(`${where} has no description prose above its block tags.`)
}

/**
 * Check the full function contract for one labeled function-like declaration:
 * description prose, `@param` per parameter, `@returns` on a result that is not empty.
 * @param where - the offender label violations open with.
 * @param raw - the declaration's raw JSDoc block ('' if none).
 * @param parameters - the declaration's parameter list.
 * @param returnType - the return type annotation, or undefined when inferred.
 * @param returnsWaived - suppress the `@returns`/annotation requirement (a
 * declarator-annotated const defers its return contract to the named type).
 * @param w - the walk state violations append to.
 */
export function checkFunctionLike(
  where: string,
  raw: string,
  parameters: readonly JsDocParameter[],
  returnType: TypeNode | undefined,
  returnsWaived: boolean,
  w: Walk,
) {
  if (!raw) { w.violations.push(`${where} has no JSDoc.`); return }
  if (!parseJsDoc(raw).doc) w.violations.push(`${where} has no description prose above its block tags.`)
  const { params, returns } = parseTags(raw)
  checkParams(where, 'exported', parameters, params, w.sf, isThisParameter, w.violations)
  if (!returnsWaived) checkReturns(where, returnType, returns, w.sf, w.violations)
}

/** The exported name of one declaration, when it has an identifier name. */
export function declarationName(declaration: Node): string | undefined {
  if (isFunctionDeclaration(declaration) || isClassDeclaration(declaration)
    || isInterfaceDeclaration(declaration) || isTypeAliasDeclaration(declaration)
    || isEnumDeclaration(declaration) || isImportEqualsDeclaration(declaration)) {
    const name = declaration.name
    if (name !== undefined && isIdentifier(name)) return name.text
    return undefined
  }
  if (isModuleDeclaration(declaration) && isIdentifier(declaration.name)) return declaration.name.text
  return undefined
}

/**
 * Find inherited documentation for a class member without exempting a newly public API.
 * @param cls - the class whose heritage to search.
 * @param name - the member name to look up.
 * @param staticSide - whether to search the constructor side instead of the instance side.
 * @param checker - the program's type checker.
 * @returns inherited parameter and return coverage, or `null` when none applies.
 */
function heritageExemption(
  cls: ClassDeclaration,
  name: string,
  staticSide: boolean,
  checker: Checker,
): { baseParams: Set<string> | null; baseVoidReturn: boolean | null } | null {
  for (const clause of cls.heritageClauses ?? []) {
    for (const t of clause.types) {
      const type = staticSide ? checker.getTypeAtLocation(t.expression) : checker.getTypeAtLocation(t)
      if (type === undefined) continue // unresolvable heritage: no exemption to grant
      const prop = checker.getPropertyOfType(type, name)
      if (prop === undefined) continue
      const decls = prop.declarations
      if (decls.length > 0 && decls.every((handle) => {
        const d = handle.resolve()
        return d !== undefined && isProtectedDeclaration(d)
      })) continue // public override of a protected base: new API
      let baseParams: Set<string> | null = null
      let baseVoidReturn: boolean | null = null
      for (const handle of decls) {
        const d = handle.resolve()
        if (d === undefined) continue
        let params: readonly ParameterDeclaration[] | undefined
        let returnType: TypeNode | undefined
        if (isMethodDeclaration(d) || isMethodSignatureDeclaration(d)) {
          params = d.parameters
          returnType = d.type
        } else if ((isPropertySignatureDeclaration(d) || isPropertyDeclaration(d)) && d.type !== undefined && isFunctionTypeNode(d.type)) {
          params = d.type.parameters
          returnType = d.type.type
        } else continue
        baseParams ??= new Set()
        // Leading underscores are the deliberately-unused marker (lint
        // argsIgnorePattern), not a rename: `_cwd` overriding `cwd` is the
        // same parameter, so compare underscore-stripped on both sides.
        for (const p of params) if (isIdentifier(p.name)) baseParams.add(p.name.text.replace(/^_+/, ''))
        if (returnType !== undefined) {
          const isVoidish = /^(void|Promise<void>)$/.test(returnType.getText(d.getSourceFile()).replace(/\s+/g, ' '))
          baseVoidReturn = (baseVoidReturn ?? true) && isVoidish
        }
      }
      return { baseParams, baseVoidReturn }
    }
  }
  return null
}

/**
 * Peel a `Promise`/`PromiseLike` type reference so a void-like awaited result
 * is classified the way the checker's awaited type was.
 * @param checker - the program's type checker.
 * @param type - the type to unwrap.
 * @returns the awaited type, or the input when it is not a promise reference.
 */
function awaitedType(checker: Checker, type: Type): Type {
  if (type.isTypeReference()) {
    const name = type.getTarget().getSymbol()?.name
    if (name === 'Promise' || name === 'PromiseLike') {
      const awaited = checker.getTypeArguments(type)[0]
      if (awaited !== undefined) return awaitedType(checker, awaited)
    }
  }
  return type
}

/**
 * Whether one type is void-like (void, undefined, never, or a promise of one).
 * @param checker - the program's type checker.
 * @param type - the type to classify.
 * @returns true when the type carries nothing to document.
 */
function isVoidishResult(checker: Checker, type: Type): boolean {
  if (type.isUnionType()) return type.getTypes().every(constituent => isVoidishResult(checker, constituent))
  const awaited = awaitedType(checker, type)
  return (awaited.flags & (TypeFlags.Void | TypeFlags.Undefined | TypeFlags.Never)) !== 0
}

/**
 * True when a method's INFERRED return type is void-like (void, undefined,
 * never, or a promise of one) — the one return the walk asks the checker to
 * classify: an unannotated override above a heritage member whose return is
 * `void`-like, where demanding an annotation just to prove faithfulness would
 * be boilerplate.
 * @param m - a method declaration with no return type annotation.
 * @param checker - the program's type checker.
 * @returns true when the inferred result carries nothing to document.
 */
function inferredReturnIsVoidish(m: MethodDeclaration, checker: Checker): boolean {
  const sig = checker.getSignatureFromDeclaration(m)
  if (sig === undefined) return true // no callable signature: nothing classifiable to document
  const returned = checker.getReturnTypeOfSignature(sig)
  if (returned === undefined) return true
  return isVoidishResult(checker, returned)
}

/**
 * Check one exported class: class-level prose, the function contract on every
 * public method (overload implementations exempt), and description prose on
 * public properties and accessors (a get/set pair is covered by the getter's
 * doc). Heritage-declared members are exempt per heritageExemption (an
 * override's extra parameters keep their @param duty); plugin-protocol
 * statics are exempt; constructors are not checked (framework-constructed
 * plugins, and the class doc owns the story).
 * @param cls - the exported class declaration.
 * @param name - the class's exported name (namespace-qualified).
 * @param w - the walk state violations append to.
 */
export function checkClass(cls: ClassDeclaration, name: string, w: Walk) {
  checkDescribed(`exported class '${name}' (${pointer(w.rel, w.sf, cls)})`, rawJsDoc(w.text, cls), w)
  const overloadSigs = new Set<string>()
  const documentedGetters = new Set<string>()
  for (const m of cls.members) {
    const memberName = classMemberName(m)
    if (memberName !== undefined && isComputedPropertyName(memberName)) continue
    if (isMethodDeclaration(m) && !m.body) overloadSigs.add(m.name.getText(w.sf))
    if (isGetAccessorDeclaration(m)) documentedGetters.add(m.name.getText(w.sf))
  }
  for (const m of cls.members) {
    if (isNonPublic(m) || isConstructorDeclaration(m)) continue
    const memberName = classMemberName(m)
    if (memberName === undefined || isComputedPropertyName(memberName)) continue
    const mname = memberName.getText(w.sf)
    if (isStatic(m) && PROTOCOL_STATICS.has(mname)) continue // cordis plugin-protocol slot
    const exemption = heritageExemption(cls, mname, isStatic(m), w.checker)
    if (isMethodDeclaration(m)) {
      if (m.body && overloadSigs.has(mname)) continue // overload implementation: the signatures carry the docs
      const where = `exported class method '${name}.${mname}' (${pointer(w.rel, w.sf, m)})`
      if (exemption !== null) {
        const raw = rawJsDoc(w.text, m)
        // The heritage declaration owns the prose; parameters the base never
        // names — including binding patterns, which no base declaration can
        // name — are new API and keep their @param duty.
        const base = exemption.baseParams
        const inBase = (p: JsDocParameter): boolean =>
          base !== null && p.name.text !== undefined && base.has(p.name.text.replace(/^_+/, ''))
        if (base !== null && m.parameters.some(p => !isThisParameter(p) && !inBase(p))) {
          checkParams(where, 'exported', m.parameters, parseTags(raw).params, w.sf,
            p => isThisParameter(p) || inBase(p), w.violations)
        }
        // An empty base return carried no `@returns` duty, so a subclass that
        // grows a concrete result documents that result itself.
        if (exemption.baseVoidReturn === true) {
          if (m.type !== undefined) {
            checkReturns(where, m.type, parseTags(raw).returns, w.sf, w.violations)
          } else if (!inferredReturnIsVoidish(m, w.checker)) {
            w.violations.push(`${where} returns a non-void result its heritage declaration does not document; annotate the return type and add @returns.`)
          }
        }
        continue
      }
      checkFunctionLike(where, rawJsDoc(w.text, m), m.parameters, m.type, false, w)
    } else if (exemption !== null) {
      continue // the heritage declaration owns the doc (properties/accessors carry no own parameters)
    } else if (isGetAccessorDeclaration(m) || isPropertyDeclaration(m)) {
      const kind = isPropertyDeclaration(m) ? 'property' : 'accessor'
      checkDescribed(`exported class ${kind} '${name}.${mname}' (${pointer(w.rel, w.sf, m)})`, rawJsDoc(w.text, m), w)
    } else if (isSetAccessorDeclaration(m) && !documentedGetters.has(mname)) {
      checkDescribed(`exported class accessor '${name}.${mname}' (${pointer(w.rel, w.sf, m)})`, rawJsDoc(w.text, m), w)
    }
    // index signatures / static blocks: no named API
  }
}
