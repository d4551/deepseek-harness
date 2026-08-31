/**
 * TypeScript 7 comparison helpers shared by Typert type-model tests.
 */

import type { Diagnostic } from 'typescript/unstable/sync'
import { flattenDiagnosticMessage } from '@deepseek-ai/dsh-diagnostic-text'

/**
 * Normalize a repository path for cross-platform comparison.
 * @param path - file path.
 * @returns slash-normalized path.
 */
export function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * Flatten one TypeScript 7 diagnostic to a single message.
 * @param diagnostic - diagnostic from a program or project.
 * @returns flattened message text.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return flattenDiagnosticMessage(diagnostic, '\n')
}
