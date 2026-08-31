/**
 * TypeScript 7 configured project for one Typert face or package tsconfig.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SourceFile } from 'typescript/unstable/ast'
import { API, type Checker, type Diagnostic, type Emitter, type Program, type Project } from 'typescript/unstable/sync'
import { compilerApi, flattenDiagnosticMessageText } from './ts7-session.ts'

/** One opened TypeScript 7 project and its checker. */
export class FaceProject {
  private readonly api: API
  /** The opened project. */
  readonly project: Project
  /** The project's program. */
  readonly program: Program
  /** The project's checker. */
  readonly checker: Checker
  /** The project's emitter, used to print nodes. */
  readonly emitter: Emitter
  /** Absolute path of the tsconfig this project was opened from. */
  readonly configPath: string

  /**
   * @param configPath - absolute tsconfig path to open.
   */
  constructor(configPath: string) {
    this.configPath = resolve(configPath)
    this.api = compilerApi()
    const snapshot = this.api.updateSnapshot({ openProjects: [this.configPath] })
    const project = snapshot.getProject(this.configPath)
    if (project === undefined) {
      throw new Error(`TypeScript project did not open ${this.configPath}`)
    }
    this.project = project
    this.program = project.program
    this.checker = project.checker
    this.emitter = project.emitter
  }

  /**
   * Return every source file loaded into the project graph.
   * @returns program source files, including libraries.
   */
  sourceFiles(): readonly SourceFile[] {
    return this.program.getSourceFileNames()
      .map(fileName => this.program.getSourceFile(fileName))
      .filter(sourceFile => sourceFile !== undefined)
  }

  /**
   * Return one program source file by absolute path.
   * @param fileName - absolute path.
   * @returns the bound source file when the program loaded it.
   */
  sourceFile(fileName: string): SourceFile | undefined {
    return this.program.getSourceFile(fileName)
  }

  /**
   * File-local syntactic and semantic diagnostics.
   * @returns program diagnostics that name a file.
   */
  fileDiagnostics(): readonly Diagnostic[] {
    return [
      ...this.program.getSyntacticDiagnostics(),
      ...this.program.getSemanticDiagnostics(),
    ].filter(diagnostic => diagnostic.fileName !== undefined && existsSync(diagnostic.fileName))
  }

  /**
   * Print a node through this project's emitter.
   * @param node - AST node bound in this program.
   * @returns printed TypeScript text.
   */
  printNode(node: import('typescript/unstable/ast').Node): string {
    return this.emitter.printNode(node)
  }

  /**
   * Flatten one diagnostic to a single line.
   * @param diagnostic - TypeScript 7 diagnostic.
   * @returns message text.
   */
  formatDiagnostic(diagnostic: Diagnostic): string {
    return flattenDiagnosticMessageText(diagnostic, '\n')
  }
}
