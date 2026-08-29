/**
 * Workspace-level Typert analysis: registration inventory, diagnostics, and
 * per-face TypeScript 7 projects.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isClassDeclaration,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
} from 'typescript/unstable/ast/is'
import type { Diagnostic } from 'typescript/unstable/sync'
import { parseConfig, type ParsedConfig } from './analyzer-config.ts'
import { declarationText } from './analyzer-docs.ts'
import { TypertAnalysisError, type AnalysisMode, type SourceEdit } from './analyzer-error.ts'
import { packageExportTargets, sourcePathForExport } from './analyzer-exports.ts'
import { FaceAnalyzer } from './analyzer-face.ts'
import { loadRegistrations, mergeWorkspaceModels } from './analyzer-register.ts'
import { localImportTargets, sourceFileHasSurface } from './analyzer-surface.ts'
import type { DiscoveredTypertPackage, PackageRegistration } from './analyzer-types.ts'
import { isWithin, realPath, slash, uniqueBy } from './analyzer-util.ts'
import type { CrossFaceLink, FaceModel, SourceDeclarationModel, TypertFace, WorkspaceModel } from './model.ts'
import { FaceProject } from './ts7-project.ts'
import { notifyFileChanged, parsePath } from './ts7-session.ts'
import { hasModifier, isTypeDeclaration } from './ts7-syntax.ts'

/** Workspace analysis configuration. */
export interface WorkspaceAnalyzerOptions {
  readonly root: string
  readonly hostConfig?: string
  readonly clientConfig?: string
  readonly packages?: readonly string[]
  readonly faces?: readonly TypertFace[]
  readonly checkDiagnostics?: boolean
  readonly mode?: AnalysisMode
  readonly caches?: WorkspaceCaches
}

/** Shared memo over one immutable workspace snapshot. */
export class WorkspaceCaches {
  readonly configs = new Map<string, ParsedConfig>()
  readonly registrations = new Map<string, PackageRegistration[]>()
  private readonly projects = new Map<string, FaceProject>()

  config(path: string): ParsedConfig {
    let parsed = this.configs.get(path)
    if (parsed === undefined) {
      parsed = parseConfig(path)
      this.configs.set(path, parsed)
    }
    return parsed
  }

  /**
   * Open one tsconfig as a TypeScript 7 project, reused across analyses.
   * @param configPath - absolute tsconfig path.
   * @returns the memoized project.
   */
  faceProject(configPath: string): FaceProject {
    const key = realPath(configPath)
    let project = this.projects.get(key)
    if (project === undefined) {
      project = new FaceProject(key)
      this.projects.set(key, project)
    }
    return project
  }

  /**
   * Notify the compiler session after a write-mode edit.
   * @param file - path of the edited file.
   */
  invalidate(file: string) {
    notifyFileChanged(file)
  }
}

/** Analyze host and client as independent TypeScript programs. */
export class WorkspaceAnalyzer {
  private readonly options: {
    readonly root: string
    readonly hostConfig: string
    readonly clientConfig: string
    readonly faces: readonly TypertFace[]
    readonly checkDiagnostics: boolean
    readonly mode: AnalysisMode
    readonly packages?: readonly string[]
  }
  private queuedEdit: SourceEdit | undefined
  private readonly crossFaceLinks = new Map<string, CrossFaceLink>()
  private readonly checkedProjects = new Set<string>()
  private registrations: PackageRegistration[] = []
  private readonly caches: WorkspaceCaches

  constructor(options: WorkspaceAnalyzerOptions) {
    this.options = {
      root: realPath(options.root),
      hostConfig: options.hostConfig ?? 'tsconfig.host.json',
      clientConfig: options.clientConfig ?? 'tsconfig.client.json',
      faces: options.faces ?? ['host', 'client'],
      checkDiagnostics: options.checkDiagnostics ?? true,
      mode: options.mode ?? 'check',
      ...options.packages === undefined ? {} : { packages: options.packages },
    }
    this.caches = options.caches ?? new WorkspaceCaches()
  }

  /**
   * Build the workspace model. Write mode applies inferred annotations and then
   * returns a fresh check-mode analysis of the edited projects.
   * @returns the independent face models and their explicit cross-face links.
   */
  analyze(): WorkspaceModel {
    this.registrations = loadRegistrations({
      root: this.options.root,
      hostConfig: this.options.hostConfig,
      clientConfig: this.options.clientConfig,
      caches: this.caches,
    })
    const selected = this.options.packages === undefined ? undefined : new Set(this.options.packages)
    const faces: FaceModel[] = []
    for (const face of this.options.faces) {
      const registrations = this.registrations.filter(registration =>
        registration.face === face && (selected === undefined || selected.has(registration.name)))
      if (registrations.length === 0) continue
      if (this.options.checkDiagnostics) {
        for (const registration of registrations) this.checkProject(registration)
      }
      const aggregatePath = resolve(
        this.options.root,
        face === 'host' ? this.options.hostConfig : this.options.clientConfig,
      )
      if (!existsSync(aggregatePath)) continue
      const analyzer = new FaceAnalyzer({
        root: this.options.root,
        face,
        project: this.caches.faceProject(aggregatePath),
        registrations,
        allRegistrations: this.registrations,
        mode: this.options.mode,
        crossFaceLinks: this.crossFaceLinks,
      })
      const model = analyzer.analyze()
      if (analyzer.queuedEdit !== undefined) {
        this.queuedEdit = analyzer.queuedEdit
        break
      }
      faces.push(model)
    }
    if (this.queuedEdit !== undefined) {
      this.applyEdit(this.queuedEdit)
      return new WorkspaceAnalyzer({ ...this.options, caches: this.caches, mode: 'write' }).analyze()
    }
    if (this.options.mode === 'write') {
      return new WorkspaceAnalyzer({ ...this.options, caches: this.caches, mode: 'check' }).analyze()
    }
    return {
      faces,
      crossFaceLinks: [...this.crossFaceLinks.values()].sort((left, right) =>
        left.fromFace.localeCompare(right.fromFace)
        || left.fromPackage.localeCompare(right.fromPackage)
        || left.toFace.localeCompare(right.toFace)
        || left.toPackage.localeCompare(right.toPackage)
        || left.subpath.localeCompare(right.subpath)
        || left.name.localeCompare(right.name)),
    }
  }

  /**
   * Analyze an explicit package selection through bounded compiler programs.
   * @param batchSize - maximum selected packages in one face program.
   * @returns one merged workspace model.
   */
  analyzeInBatches(batchSize = 8): WorkspaceModel {
    if (this.options.packages === undefined) {
      throw new TypertAnalysisError('typert: batched analysis requires an explicit package selection')
    }
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new TypertAnalysisError(`typert: batch size must be a positive integer, received ${String(batchSize)}`)
    }
    const batches: WorkspaceModel[] = []
    for (let index = 0; index < this.options.packages.length; index += batchSize) {
      batches.push(new WorkspaceAnalyzer({
        ...this.options,
        caches: this.caches,
        packages: this.options.packages.slice(index, index + batchSize),
      }).analyze())
    }
    return mergeWorkspaceModels(batches)
  }

  /**
   * Discover package faces from public-export-reachable Cordis augmentations
   * and explicit `@typert` roots without constructing a type-checker program.
   * @returns contributors grouped by package with deterministic face order.
   */
  discoverPackages(): DiscoveredTypertPackage[] {
    const registrations = loadRegistrations({
      root: this.options.root,
      hostConfig: this.options.hostConfig,
      clientConfig: this.options.clientConfig,
      caches: this.caches,
    }).filter(registration => this.options.faces.includes(registration.face)
      && this.registrationHasSurface(registration))
    const packages = new Map<string, { root: string; faces: Set<TypertFace> }>()
    for (const registration of registrations) {
      const current = packages.get(registration.name) ?? {
        root: slash(relative(this.options.root, registration.root)),
        faces: new Set<TypertFace>(),
      }
      current.faces.add(registration.face)
      packages.set(registration.name, current)
    }
    return [...packages]
      .map(([packageName, value]) => ({
        package: packageName,
        root: value.root,
        faces: [...value.faces].sort(),
      }))
      .sort((left, right) => left.package.localeCompare(right.package))
  }

  /**
   * Index top-level exported type declarations without promoting them to graph roots.
   * @returns declarations from the selected faces and package projects.
   */
  indexSourceDeclarations(): SourceDeclarationModel[] {
    const selected = this.options.packages === undefined ? undefined : new Set(this.options.packages)
    const declarations: SourceDeclarationModel[] = []
    for (const registration of loadRegistrations({
      root: this.options.root,
      hostConfig: this.options.hostConfig,
      clientConfig: this.options.clientConfig,
      caches: this.caches,
    })) {
      if (!this.options.faces.includes(registration.face)
        || (selected !== undefined && !selected.has(registration.name))) continue
      this.indexRegistration(registration, declarations)
    }
    return uniqueBy(declarations, declaration =>
      `${declaration.face}\0${declaration.location.file}\0${String(declaration.location.line)}\0${declaration.name}`)
      .sort((left, right) => left.face.localeCompare(right.face)
        || left.location.file.localeCompare(right.location.file)
        || left.location.line - right.location.line)
  }

  private indexRegistration(registration: PackageRegistration, declarations: SourceDeclarationModel[]) {
    for (const file of registration.config.fileNames) {
      const relativeFile = slash(relative(this.options.root, file))
      if (!existsSync(file)
        || !isWithin(realPath(file), join(registration.root, 'src'))
        || !/\.(?:cts|mts|ts)$/.test(file)) continue
      const sourceFile = parsePath(file)
      for (const statement of sourceFile.statements) {
        if (!isTypeDeclaration(statement)
          || statement.name === undefined
          || !hasModifier(statement, SyntaxKind.ExportKeyword)) continue
        const position = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
        declarations.push({
          face: registration.face,
          package: registration.name,
          name: statement.name.text,
          kind: isClassDeclaration(statement)
            ? 'class'
            : isInterfaceDeclaration(statement)
              ? 'interface'
              : isTypeAliasDeclaration(statement)
                ? 'alias'
                : 'enum',
          location: {
            file: relativeFile,
            line: position.line + 1,
            column: position.character + 1,
          },
          text: declarationText(statement),
        })
      }
    }
  }

  private registrationHasSurface(registration: PackageRegistration): boolean {
    const seen = new Set<string>()
    const queue = packageExportTargets(registration.manifest)
      .filter(([subpath, target]) => (registration.exportSubpaths === undefined
        || registration.exportSubpaths.includes(subpath))
        && !target.includes('*')
        && subpath !== './package.json'
        && subpath !== './typert'
        && subpath !== './client/typert'
        && subpath !== './remote'
        && !target.endsWith('.json'))
      .map(([, target]) => sourcePathForExport(registration.root, target))
      .filter(existsSync)
    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) continue
      const file = realPath(next)
      if (seen.has(file) || !isWithin(file, registration.root)) continue
      seen.add(file)
      const sourceFile = parsePath(file)
      if (sourceFileHasSurface(sourceFile)) return true
      for (const imported of localImportTargets(sourceFile, file)) {
        if (isWithin(imported, registration.root)) queue.push(imported)
      }
    }
    return false
  }

  private checkProject(registration: PackageRegistration) {
    if (this.checkedProjects.has(registration.config.path)) return
    this.checkedProjects.add(registration.config.path)
    const project = this.caches.faceProject(registration.config.path)
    const diagnostics = project.fileDiagnostics().filter(diagnostic =>
      diagnostic.fileName !== undefined && isWithin(diagnostic.fileName, registration.root))
    if (diagnostics.length === 0) return
    throw new TypertAnalysisError(
      diagnostics.map(diagnostic => formatProgramDiagnostic(this.options.root, registration.face, project, diagnostic)).join('\n'),
    )
  }

  private applyEdit(edit: SourceEdit) {
    const source = readFileSync(edit.file, 'utf8')
    writeFileSync(edit.file, source.slice(0, edit.position) + edit.text + source.slice(edit.position))
    this.caches.invalidate(edit.file)
  }
}

function formatProgramDiagnostic(
  root: string,
  face: TypertFace,
  project: FaceProject,
  diagnostic: Diagnostic,
): string {
  const message = project.formatDiagnostic(diagnostic)
  const fileName = diagnostic.fileName ?? ''
  const sourceFile = fileName === '' ? undefined : project.sourceFile(fileName)
  const position = sourceFile === undefined
    ? { line: 0, character: 0 }
    : sourceFile.getLineAndCharacterOfPosition(diagnostic.pos)
  const file = slash(relative(root, fileName))
  return `typert(${face}): ${file}:${String(position.line + 1)}:${String(position.character + 1)}: TypeScript TS${String(diagnostic.code)}: ${message}`
}
