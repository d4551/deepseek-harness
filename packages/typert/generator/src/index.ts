/**
 * Public API of the Typert analyzer, compiler-independent model, and
 * model-driven artifact emitters. Build wiring lives in the `./tsdown`
 * subpath.
 * @module @deepseek-ai/dsh-typert-generator
 */

export { TypertAnalysisError } from './analyzer-error.ts'
export type { AnalysisMode } from './analyzer-error.ts'
export type { DiscoveredTypertPackage, PackageRegistration } from './analyzer-types.ts'
export { WorkspaceAnalyzer, WorkspaceCaches } from './analyzer-workspace.ts'
export type { WorkspaceAnalyzerOptions } from './analyzer-workspace.ts'
export { FaceModelEmitter, TypertEmitError } from './emitter.ts'
export type { ModelEmitResult } from './emitter.ts'
export { CordisCatalogProjector, REGION_BEGIN, REGION_END, collectEvents, collectServices, projectCordisCatalog, renderInheritedPage, renderPageRegion } from './cordis-catalog.ts'
export type { CordisCatalogModel, CordisCatalogPolicy, EventEntry, InheritedEntry, ServiceEntry, ServiceMethodEntry } from './cordis-catalog.ts'
export { TypeGraphRenderer, TypeGraphRenderError } from './renderer.ts'
export { WorkspaceTypertGenerator } from './workspace.ts'
export type { WorkspaceEmitResult } from './workspace.ts'
export type { AccessorMemberModel, CrossFaceLink, DocumentationModel, EnumMemberModel, EventModel, ExportModel, FaceModel, InvocationModel, InvocationParameterModel, JsDocTagModel, KeywordTypeName, MemberBase, MemberModel, MemberVisibility, MethodMemberModel, ObjectModel, PackageModel, ParameterModel, PropertyMemberModel, RemoteBoundaryModel, RemoteTypeImportModel, SchemaModel, ServiceModel, SignatureMemberModel, SignatureModel, SourceDeclarationModel, SourceLocation, SymbolId, TemplateSpanModel, TupleElementModel, TypeDeclarationModel, TypeDeclarationPartModel, TypeGraph, TypeNodeId, TypeNodeModel, TypeOperatorName, TypeParameterModel, TypeTargetModel, TypertFace, WorkspaceModel, childTypeNodeIds } from './model.ts'
