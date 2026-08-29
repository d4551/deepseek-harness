/**
 * Generate dsh-scope's invariant resolver map from the repository TypeScript
 * Program.
 *
 * A scoped event declares `this: Scoped<Base>`. Real `scopeTarget(base, key)`
 * calls establish the routing-key type for that base. The generator searches
 * every event payload parameter and one property level for exactly one type
 * equivalent to that key. Each generated resolver compiles against the merged
 * `Events` parameter tuple. Zero matches require `@dshScopeScan unsupported`;
 * multiple matches are ambiguous and always fail loud.
 *
 *   `tsx scripts/gen-scoped-events.ts`          -> write the generated source
 *   `tsx scripts/gen-scoped-events.ts --check`  -> exit 1 when it is stale
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  FunctionDeclaration, MethodSignatureDeclaration, Node, ParameterDeclaration, SourceFile, TypeAliasDeclaration,
} from 'typescript/unstable/ast'
import {
  isCallExpression,
  isFunctionDeclaration,
  isInterfaceDeclaration,
  isMethodSignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
} from 'typescript/unstable/ast/is'
import { NodeBuilderFlags, TypeFlags, type Checker, type Symbol, type Type } from 'typescript/unstable/sync'
import {
  dedupeCandidates, hasNonPublicDeclaration, isCordisModuleInterface, isThisParameter, parseScopeTag, quote,
  type SubjectCandidate,
} from './gen-scoped-events-scan.ts'
import { pointer, rawJsDoc } from './jsdoc.ts'
import { TypeScriptProject } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'packages/core/scope/src/scoped-events.generated.ts'
const SCOPE_DOC_MARKER = 'Scope-filtered dispatch'

interface ScopeTargetContract {
  baseType: Type
  keyType: Type
  source: string
}

interface ScopedEventResolver {
  event: string
  candidate: SubjectCandidate | null
}

/** Program-backed analyzer and renderer for the generated scoped-event resolvers. */
class ScopedEventGenerator {
  private readonly checker: Checker
  private readonly packageSources: SourceFile[]
  private readonly scopeTargetDeclaration: FunctionDeclaration
  private readonly scopedSymbol: Symbol
  private readonly violations: string[] = []

  constructor(private readonly project: TypeScriptProject) {
    this.checker = project.checker
    this.packageSources = project.sourceFiles().filter((sourceFile) => {
      return /^packages\/[^/]+\/[^/]+\/src\/.+\.ts$/.test(project.relativePath(sourceFile))
    })
    this.scopeTargetDeclaration = this.functionDeclaration(
      'packages/core/scope/src/index.ts',
      'scopeTarget',
    )
    this.scopedSymbol = this.typeAliasSymbol(
      'packages/core/scope/src/index.ts',
      'Scoped',
    )
  }

  /** Render the complete generated TypeScript module or throw every contract violation. */
  render(): string {
    const contracts = this.collectScopeTargetContracts()
    const resolvers = this.collectScopedEventResolvers(contracts)
    if (this.violations.length > 0) {
      throw new Error(
        `gen-scoped-events: ${this.violations.length} scoped-event contract violation(s):\n`
        + this.violations.map(violation => `  - ${violation}`).join('\n'),
      )
    }
    return [
      '/**',
      ' * Generated scoped-event routing-subject resolvers for dsh-scope invariants.',
      ' * Do not edit by hand; run `bun run gen-scoped-events`.',
      ' *',
      ' * @module @deepseek-ai/dsh-scope/scoped-events.generated',
      ' */',
      '',
      'type ScopedSubjectResolver = (args: readonly unknown[]) => unknown',
      '',
      'const scopedSubjectResolvers: Readonly<Record<string, ScopedSubjectResolver | null>> = Object.freeze({',
      ...resolvers.map(({ event, candidate }) => {
        if (candidate === null) return `  '${event}': null,`
        const subject = candidate.property === undefined
          ? `args[${candidate.parameter}]`
          : `(args[${candidate.parameter}] as Record<string, unknown>)[${quote(candidate.property)}]`
        return `  '${event}': args => ${subject},`
      }),
      '})',
      '',
      '/**',
      ' * Resolve the routing key named by one scoped event payload. A null',
      ' * resolver means the payload cannot expose its external routing key, so the',
      ' * invariant checks carrier presence only.',
      ' * @param event - runtime Cordis event name.',
      ' * @returns the generated subject resolver, null for presence-only,',
      ' *   or undefined when the event is not scope-filtered.',
      ' */',
      'export function scopedSubjectResolverFor(event: string): ScopedSubjectResolver | null | undefined {',
      '  return scopedSubjectResolvers[event]',
      '}',
      '',
    ].join('\n')
  }

  /** Resolve one named function declaration from a known source file. */
  private functionDeclaration(relativePath: string, name: string): FunctionDeclaration {
    const sourceFile = this.project.sourceFile(relativePath)
    const declaration = sourceFile.statements.find((statement): statement is FunctionDeclaration => {
      return isFunctionDeclaration(statement) && statement.name?.text === name
    })
    if (!declaration) throw new Error(`gen-scoped-events: cannot resolve function ${name} from ${relativePath}`)
    return declaration
  }

  /** Resolve one named type-alias symbol from a known source file. */
  private typeAliasSymbol(relativePath: string, name: string): Symbol {
    const sourceFile = this.project.sourceFile(relativePath)
    const declaration = sourceFile.statements.find((statement): statement is TypeAliasDeclaration => {
      return isTypeAliasDeclaration(statement) && statement.name.text === name
    })
    const symbol = declaration && this.checker.getSymbolAtLocation(declaration.name)
    if (!symbol) throw new Error(`gen-scoped-events: cannot resolve type ${name} from ${relativePath}`)
    return symbol
  }

  /** Collect every real scopeTarget(base, key) base/key type contract. */
  private collectScopeTargetContracts(): ScopeTargetContract[] {
    const contracts: ScopeTargetContract[] = []
    const visit = (sourceFile: SourceFile, node: Node): void => {
      if (isCallExpression(node)
        && this.checker.getResolvedSignature(node)?.declaration?.resolve() === this.scopeTargetDeclaration) {
        const base = node.arguments[0]
        const key = node.arguments[1]
        if (!base || !key) {
          const source = pointer(this.project.relativePath(sourceFile), sourceFile, node)
          this.violations.push(`${source} calls scopeTarget without base and key arguments`)
        } else {
          const baseType = this.checker.getTypeAtLocation(base)
          const keyType = this.checker.getTypeAtLocation(key)
          if (baseType === undefined || keyType === undefined) {
            const source = pointer(this.project.relativePath(sourceFile), sourceFile, node)
            this.violations.push(`${source} calls scopeTarget but the checker could not resolve argument types`)
          } else {
            contracts.push({
              baseType,
              keyType,
              source: pointer(this.project.relativePath(sourceFile), sourceFile, node),
            })
          }
        }
      }
      node.forEachChild((child) => { visit(sourceFile, child) })
    }
    for (const sourceFile of this.packageSources) visit(sourceFile, sourceFile)
    return contracts
  }

  /** Collect every Events member and derive its generated resolver. */
  private collectScopedEventResolvers(contracts: readonly ScopeTargetContract[]): ScopedEventResolver[] {
    const resolvers: ScopedEventResolver[] = []
    for (const sourceFile of this.packageSources) {
      const rel = this.project.relativePath(sourceFile)
      const visit = (node: Node): void => {
        if (isInterfaceDeclaration(node) && node.name.text === 'Events' && isCordisModuleInterface(node)) {
          for (const member of node.members) {
            if (!isMethodSignatureDeclaration(member) || !isStringLiteral(member.name)) continue
            const event = member.name.text
            const raw = rawJsDoc(sourceFile.text, member)
            const where = `event '${event}' (${pointer(rel, sourceFile, member)})`
            const tag = parseScopeTag(raw, where, this.violations)
            const thisParameter = member.parameters.find(isThisParameter)
            const scopedBase = thisParameter && this.scopedBaseType(thisParameter)
            if (!scopedBase) {
              if (raw.includes(SCOPE_DOC_MARKER)) {
                this.violations.push(
                  `${where} documents scope-filtered dispatch but its signature has no this: Scoped<...> receiver`,
                )
              }
              if (tag.present) {
                this.violations.push(`${where} has @dshScopeScan metadata but is not a Scoped event`)
              }
              continue
            }
            if (!raw.includes(SCOPE_DOC_MARKER)) {
              this.violations.push(
                `${where} has this: Scoped<...> but its JSDoc does not explain "${SCOPE_DOC_MARKER}"`,
              )
            }
            const keyType = this.routingKeyType(where, scopedBase, contracts)
            if (!keyType) continue
            const candidates = this.subjectCandidates(member)
              .filter(candidate => this.typesEquivalent(candidate.type, keyType))
            if (candidates.length > 1) {
              this.violations.push(
                `${where} has multiple routing-key candidates for ${this.typeText(keyType)}: `
                + candidates.map(candidate => `${candidate.path}: ${this.typeText(candidate.type)}`).join(', '),
              )
              continue
            }
            if (candidates.length === 0) {
              if (!tag.unsupported) {
                const keyLabel = this.typeText(keyType)
                this.violations.push(
                  `${where} exposes no parameter or one-level property equivalent to routing key type ${keyLabel}; `
                  + 'add @dshScopeScan unsupported only when the key is intentionally absent from the payload',
                )
              }
              resolvers.push({ event, candidate: null })
              continue
            }
            if (tag.unsupported) {
              this.violations.push(
                `${where} has unnecessary @dshScopeScan unsupported; ${candidates[0]?.path} exposes the routing key`,
              )
              continue
            }
            resolvers.push({ event, candidate: candidates[0] ?? null })
          }
        }
        node.forEachChild(visit)
      }
      visit(sourceFile)
    }
    return resolvers.sort((left, right) => left.event.localeCompare(right.event))
  }

  /** Extract the Base type from one exact this: Scoped<Base> parameter. */
  private scopedBaseType(parameter: ParameterDeclaration): Type | undefined {
    const type = this.checker.getTypeAtLocation(parameter)
    if (type === undefined || type.getAliasSymbol() !== this.scopedSymbol) return undefined
    return type.getAliasTypeArguments()[0]
  }

  /** Resolve one unambiguous key type for a scoped carrier base. */
  private routingKeyType(
    where: string,
    scopedBase: Type,
    contracts: readonly ScopeTargetContract[],
  ): Type | undefined {
    const matches = contracts.filter((contract) => {
      return this.checker.isTypeAssignableTo(this.normalizedType(contract.baseType), this.normalizedType(scopedBase))
    })
    if (matches.length === 0) {
      this.violations.push(
        `${where} has no matching scopeTarget(base, key) call for carrier base ${this.typeText(scopedBase)}`,
      )
      return undefined
    }
    const keyTypes: Type[] = []
    for (const match of matches) {
      if (!keyTypes.some(type => this.typesEquivalent(type, match.keyType))) keyTypes.push(match.keyType)
    }
    if (keyTypes.length > 1) {
      this.violations.push(
        `${where} carrier base ${this.typeText(scopedBase)} has inconsistent routing-key types: `
        + matches.map(match => `${this.typeText(match.keyType)} at ${match.source}`).join(', '),
      )
      return undefined
    }
    return keyTypes[0]
  }

  /** Enumerate every payload parameter and every accessible one-level property. */
  private subjectCandidates(member: MethodSignatureDeclaration): SubjectCandidate[] {
    const candidates: SubjectCandidate[] = []
    let runtimeIndex = 0
    for (const parameter of member.parameters) {
      if (isThisParameter(parameter)) continue
      const directPath = `args[${runtimeIndex}]`
      const parameterType = this.checker.getTypeAtLocation(parameter)
      if (parameterType === undefined) {
        runtimeIndex += 1
        continue
      }
      candidates.push({ path: directPath, parameter: runtimeIndex, type: parameterType })
      for (const property of this.checker.getPropertiesOfType(this.normalizedType(parameterType))) {
        const name = property.name
        if (name.startsWith('__@') || hasNonPublicDeclaration(property)) continue
        candidates.push({
          path: `${directPath}.${name}`,
          parameter: runtimeIndex,
          property: name,
          type: this.checker.getTypeOfSymbolAtLocation(property, parameter),
        })
      }
      runtimeIndex += 1
    }
    return dedupeCandidates(candidates)
  }

  /** Compare exact Program type identities after removing null and undefined. */
  private typesEquivalent(left: Type, right: Type): boolean {
    const normalizedLeft = this.normalizedType(left)
    const normalizedRight = this.normalizedType(right)
    if (normalizedLeft.flags & (TypeFlags.Any | TypeFlags.Unknown)) return false
    if (normalizedRight.flags & (TypeFlags.Any | TypeFlags.Unknown)) return false
    return normalizedLeft === normalizedRight
  }

  /** Remove null and undefined from a routing or candidate type. */
  private normalizedType(type: Type): Type {
    return this.checker.getNonNullableType(type) ?? type
  }

  /** Render a stable diagnostic type label. */
  private typeText(type: Type): string {
    return this.checker.typeToString(type, undefined, NodeBuilderFlags.NoTruncation)
  }
}

/**
 * Render the generated scoped-event resolver module for one repository root.
 * @param projectRoot - repository root carrying tsconfig.host.json.
 * @returns complete generated TypeScript source.
 */
export function renderScopedEvents(projectRoot: string = root): string {
  return new ScopedEventGenerator(new TypeScriptProject(projectRoot)).render()
}

/** Generate or freshness-check the fixed dsh-scope source file. */
function main(): void {
  const content = renderScopedEvents()
  const output = resolve(root, OUT)
  if (process.argv.includes('--check')) {
    const committed = existsSync(output) ? readFileSync(output, 'utf8') : null
    if (committed === content) {
      console.log(`gen-scoped-events: ${OUT} is up to date.`)
      return
    }
    console.error(`gen-scoped-events: ${OUT} is stale. Run \`bun run gen-scoped-events\` and commit it.`)
    process.exit(1)
  }
  writeFileSync(output, content)
  console.log(`gen-scoped-events: wrote ${OUT}.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
