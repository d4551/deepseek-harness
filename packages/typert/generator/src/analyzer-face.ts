/**
 * Face-level Typert analysis: one TypeScript 7 project, one FaceModel.
 */

import { analyzeFace } from './analyzer-collect.ts'
import { FaceContext, type FaceAnalyzerOptions } from './analyzer-context.ts'
import type { SourceEdit } from './analyzer-error.ts'
import type { FaceModel } from './model.ts'

/**
 * Analyze one compiler face. Extraction walks live in sibling modules and
 * take {@link FaceContext}; this class owns that context for the workspace.
 */
export class FaceAnalyzer {
  private readonly context: FaceContext

  constructor(options: FaceAnalyzerOptions) {
    this.context = new FaceContext(options)
  }

  /**
   * Extract the face model. When write-mode queues an annotation, the model
   * may be incomplete; callers read {@link queuedEdit}.
   * @returns the face model.
   */
  analyze(): FaceModel {
    return analyzeFace(this.context)
  }

  /** Pending write-mode annotation, if requiredType queued one. */
  get queuedEdit(): SourceEdit | undefined {
    return this.context.queuedEdit
  }
}
