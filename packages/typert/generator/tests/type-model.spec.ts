/**
 * Legacy type-model registration. The TS7 case bodies live in
 * type-model-cases-*.ts modules, which the split type-model-*.spec.ts files
 * register as well.
 */

import { afterEach, describe, it } from 'vitest'
import { rmSync } from 'node:fs'
import { temporaryRoots } from './type-model-helpers.ts'
import {
  buildsFaceModelsWithCrossFaceGraph,
  coversEveryModeledDiscriminant,
  discoversExplicitKeyedService,
  indexesAuthoredTopLevelExports,
  mergesBoundedPackagePrograms,
  prefersExplicitKeyedImplementation,
  rejectsExplicitServiceWithoutValidKey,
  retainsOmittedMappedValue,
} from './type-model-cases-graph.ts'
import {
  failsCheckModeAndWritesAnnotations,
  ignoresNonPackageNamespaceExports,
  recordsPublicSymbolsFromStarReExports,
  rejectsCrossFaceNamespaceReExports,
  rejectsCrossFaceReExportsOutsideExports,
  rejectsRelativeImportsAcrossFaces,
  rejectsSubpathsAbsentFromExports,
} from './type-model-cases-rules.ts'
import {
  expandsSameFacePackageExports,
  rejectsProjectsWithSourceDiagnostics,
  rejectsRelativeImportsAcrossPackages,
  rejectsSameFaceImportsOutsideExports,
  resolvesSameFaceReExportsToOwner,
} from './type-model-cases-packages.ts'
import {
  rejectsConflictingMergedVariance,
  rejectsDeclarationMergesWithoutLosslessModel,
  rejectsMergedDeclarationsOutsideFace,
  retainsEveryMergedInterfacePart,
  retainsPlainMergedInterfaces,
} from './type-model-cases-merges.ts'
import {
  confinesExplicitFaceProjectsToSelectedFace,
  handlesEmptySelectionsAndMalformedConfigs,
  ignoresEmptyCordisAugmentations,
  ignoresNonPackageAggregateReferences,
  recognizesAllAnnotationSpellings,
  rejectsMissingExportSources,
  rejectsNonClassContextServices,
  rejectsTaggedAnonymousDeclarations,
  keepsBothRuntimeFacesForClientProjects,
  skipsAmbientImportsWithoutModuleFiles,
} from './type-model-cases-discovery.ts'
import {
  acceptsPackageExportForms,
  keepsUnscopedGlobalsAsExternalTargets,
  rendersDeclarationsAsCompilableTypeScript,
  retainsSyntaxZooTypesThroughRendering,
} from './type-model-cases-render.ts'
import {
  emitsExactRootLevelArtifacts,
  emitsRunnableZodArtifacts,
  rejectsAbsentTypertExportsAndFiles,
  rejectsMisplacedTypertSubpaths,
} from './type-model-cases-artifacts.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceAnalyzer', { timeout: 60_000 }, () => {
  it('builds independent face models with an explicit cross-face type graph', () => buildsFaceModelsWithCrossFaceGraph())
  it('merges bounded package programs into the same face model', () => mergesBoundedPackagePrograms())
  it('discovers an explicitly keyed service implementation without a Context merge', () => discoversExplicitKeyedService())
  it('prefers an explicitly keyed implementation over its protocol Context merge', () => prefersExplicitKeyedImplementation())
  it('rejects an explicit service implementation without one valid key', () => rejectsExplicitServiceWithoutValidKey())
  it('indexes authored top-level exports without promoting them to graph roots', () => indexesAuthoredTopLevelExports())
  it('covers every modeled discriminant with source-authored fixture syntax', () => coversEveryModeledDiscriminant())
  it('retains an omitted mapped value when the owning project permits implicit any', () => retainsOmittedMappedValue())
  it('fails in check mode and writes inferred public annotations in write mode', () => failsCheckModeAndWritesAnnotations())
  it('rejects relative imports across face boundaries', () => rejectsRelativeImportsAcrossFaces())
  it('rejects package subpaths absent from package.json exports', () => rejectsSubpathsAbsentFromExports())
  it('rejects cross-face re-exports outside package.json exports', () => rejectsCrossFaceReExportsOutsideExports())
  it('rejects cross-face namespace re-exports until the model has a namespace target', () => rejectsCrossFaceNamespaceReExports())
  it('ignores cross-face namespace exports that are not package exports', () => ignoresNonPackageNamespaceExports())
  it('records public symbols from explicit cross-face star re-exports', () => recordsPublicSymbolsFromStarReExports())
  it('expands explicit same-face package exports through declaration targets', () => expandsSameFacePackageExports())
  it('resolves explicit same-face package re-exports to their declaration owner', () => resolvesSameFaceReExportsToOwner())
  it('rejects same-face package imports outside package.json exports', () => rejectsSameFaceImportsOutsideExports())
  it('rejects relative imports across same-face package boundaries', () => rejectsRelativeImportsAcrossPackages())
  it('rejects TypeScript projects with source diagnostics before modeling them', () => rejectsProjectsWithSourceDiagnostics())
  it('retains every authored part of a merged interface', () => retainsEveryMergedInterfacePart())
  it('rejects merged declarations that include a part outside the registered face', () => rejectsMergedDeclarationsOutsideFace())
  it('keeps unscoped global npm declarations as true external targets', () => keepsUnscopedGlobalsAsExternalTargets())
  it('skips ambient imports without physical module files while walking exported sources', () => skipsAmbientImportsWithoutModuleFiles())
  it('rejects declaration merges without a lossless model', () => rejectsDeclarationMergesWithoutLosslessModel())
  it('rejects merged interfaces with conflicting authored variance', () => rejectsConflictingMergedVariance())
  it('handles empty selections and rejects malformed aggregate configs', () => handlesEmptySelectionsAndMalformedConfigs())
  it('ignores empty Cordis augmentations during package discovery', () => ignoresEmptyCordisAugmentations())
  it('ignores aggregate references that are not named workspace packages', () => ignoresNonPackageAggregateReferences())
  it('keeps both runtime faces for an ordinary dsh.client project', () => keepsBothRuntimeFacesForClientProjects())
  it('confines explicit face projects to their selected Typert face', () => confinesExplicitFaceProjectsToSelectedFace())
  it('accepts package export forms while skipping artifact-only rows and unexported packages', () => acceptsPackageExportForms())
  it('rejects package exports whose source entry is missing', () => rejectsMissingExportSources())
  it('recognizes all supported typert annotation spellings', () => recognizesAllAnnotationSpellings())
  it('rejects an exported Context service that is not a class or interface', () => rejectsNonClassContextServices())
  it('rejects tagged anonymous declarations that cannot be named losslessly', () => rejectsTaggedAnonymousDeclarations())
  it('retains merged generic interfaces without constraints or defaults', () => retainsPlainMergedInterfaces())
})

describe('TypeGraphRenderer', { timeout: 60_000 }, () => {
  it('retains every source-authored SyntaxZoo property type through rendering', () => retainsSyntaxZooTypesThroughRendering())
  it('renders every analyzed declaration as compilable TypeScript', () => rendersDeclarationsAsCompilableTypeScript())
})

describe('WorkspaceTypertGenerator', { timeout: 60_000 }, () => {
  it('emits host and client faces through their exact root-level public artifacts', () => emitsExactRootLevelArtifacts())
  it('rejects a public Typert subpath that points outside the root-level face artifact', () => rejectsMisplacedTypertSubpaths())
  it('rejects absent Typert exports and package file entries', () => rejectsAbsentTypertExportsAndFiles())
})

describe('FaceModelEmitter', { timeout: 60_000 }, () => {
  it('emits runnable Zod JavaScript, precise declarations, and runtime package metadata', () => emitsRunnableZodArtifacts())
})
