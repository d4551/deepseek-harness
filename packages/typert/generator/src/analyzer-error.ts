/**
 * Analysis failure with a source-oriented diagnostic.
 */

/** Thrown when Typert cannot extract a workspace model. */
export class TypertAnalysisError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TypertAnalysisError'
  }
}

/** One pending write-mode annotation. */
export interface SourceEdit {
  readonly file: string
  readonly position: number
  readonly text: string
}

/** Missing-annotation handling at public business boundaries. */
export type AnalysisMode = 'check' | 'write'
