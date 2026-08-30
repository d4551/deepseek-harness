/**
 * Legacy Remote-model registration. The TS7 case bodies live in
 * remote-model-cases-emit.ts and remote-model-cases-reject.ts, which the
 * split remote-model-*.spec.ts files register as well.
 */

import { afterEach, describe, it } from 'vitest'
import { rmSync } from 'node:fs'
import { temporaryRoots } from './remote-model-helpers.ts'
import {
  discoversRemoteOnlyPackage,
  evaluatesMergedBoundaries,
  importsNestedGenericArguments,
  projectsAuthoredOptionality,
  quotesAliasedMethods,
  validatesRemoteArtifactsOnHostFaceOnly,
} from './remote-model-cases-emit.ts'
import {
  keepsOptionalJsonFieldsValid,
  methodShapeRejections,
  rejectsDuplicateEndpoints,
  rejectsMethodShape,
  rejectsNonJsonBoundary,
  rejectsRemoteExportWithoutMethods,
  rejectsScopeWithoutContext,
  rejectsScopedWireMismatch,
  rejectsUntransportableAlias,
  rejectsWorkspaceClassWithoutLookup,
} from './remote-model-cases-reject.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Remote model generation', { timeout: 60_000 }, () => {
  it('discovers a Remote-only package and emits strict direct and Context descriptors', () => discoversRemoteOnlyPackage())

  it('projects authored optionality and absence onto consumers and codecs', () => projectsAuthoredOptionality())

  it('evaluates declaration-merged mapped and conditional boundaries for codecs without widening consumer types', () => evaluatesMergedBoundaries())

  it('imports public type arguments nested under a named generic boundary', () => importsNestedGenericArguments())

  it('quotes aliased methods in generated namespace interfaces', () => quotesAliasedMethods())

  it.each(['create#v2', 'create goal', '.', '..'])('rejects untransportable Remote alias %s', (alias) => {
    rejectsUntransportableAlias(alias)
  })

  it('rejects a Remote export after its last Remote method is removed', () => rejectsRemoteExportWithoutMethods())

  it('validates Remote artifacts only on the host face of a dual-face package', () => validatesRemoteArtifactsOnHostFaceOnly())

  it.each(methodShapeRejections)('rejects $name', ({ edit, message }) => {
    rejectsMethodShape(edit, message)
  })

  it('rejects a workspace class parameter without a lookup declaration', () => rejectsWorkspaceClassWithoutLookup())

  it.each([
    ['bigint', 'bigint'],
    ['symbol', 'symbol'],
    ['undefined', 'undefined'],
    ['any', 'unconstrained any'],
    ['unknown', 'unconstrained unknown'],
  ])('rejects non-JSON Remote boundary type %s', (type, message) => {
    rejectsNonJsonBoundary(type, message)
  })

  it('keeps optional JSON object fields valid', () => keepsOptionalJsonFieldsValid())

  it('rejects a Remote Scope without a static Context declaration', () => rejectsScopeWithoutContext())

  it('rejects a direct scoped projection whose Context and lookup wire symbols differ', () => rejectsScopedWireMismatch())

  it('rejects duplicate endpoints across Remote services', () => rejectsDuplicateEndpoints())
})
