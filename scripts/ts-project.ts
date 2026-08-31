/**
 * Shared TypeScript 7 project construction for repository gates that need
 * cross-file symbols and types instead of isolated syntax trees.
 */

import { relative, resolve } from 'node:path'
import { API, type Checker, type Program } from 'typescript/unstable/sync'
import type { SourceFile } from 'typescript/unstable/ast'

/**
 * A compiler face: the two aggregates a repository-wide program may seed from.
 * The root solution is never one of them.
 */
export type CompilerFace = 'host' | 'client'

/** A repository-scoped TypeScript 7 program and its shared Checker. */
export class TypeScriptProject {
  private readonly api: API
  /** The bound TypeScript 7 program for this face. */
  readonly program: Program
  /** The checker shared by every semantic query in this project. */
  readonly checker: Checker

  /**
   * @param projectRoot - repository root the program is seeded and reported from.
   * @param face - which compiler face aggregate to open. Never open both faces
   *   in one program: they merge cordis Context under the same keys.
   */
  constructor(readonly projectRoot: string, face: CompilerFace = 'host') {
    const configPath = resolve(projectRoot, `tsconfig.${face}.json`)
    this.api = new API()
    const snapshot = this.api.updateSnapshot({ openProjects: [configPath] })
    const project = snapshot.getProject(configPath)
    if (project === undefined) {
      this.api.close()
      throw new Error(`TypeScript project did not open ${configPath}`)
    }
    this.program = project.program
    this.checker = project.checker
  }

  /**
   * Return every source file loaded into the face project graph.
   * @returns program source files, including libraries and external dependencies.
   */
  sourceFiles(): readonly SourceFile[] {
    return this.program.getSourceFileNames()
      .map(fileName => this.program.getSourceFile(fileName))
      .filter(sourceFile => sourceFile !== undefined)
  }

  /**
   * Render a loaded source file relative to the project root.
   * @param sourceFile - a source file from this project.
   * @returns a slash-separated repository-relative path.
   */
  relativePath(sourceFile: SourceFile): string {
    return relative(this.projectRoot, sourceFile.fileName).replaceAll('\\', '/')
  }

  /**
   * Return one program source file by repository-relative path.
   * @param relativePath - path relative to the project root.
   * @returns the source file bound into this project.
   */
  sourceFile(relativePath: string): SourceFile {
    const sourceFile = this.program.getSourceFile(resolve(this.projectRoot, relativePath))
    if (sourceFile === undefined) throw new Error(`TypeScript project did not load ${relativePath}`)
    return sourceFile
  }

  /** Dispose the Go compiler session this project owns. */
  close(): void {
    this.api.close()
  }
}
