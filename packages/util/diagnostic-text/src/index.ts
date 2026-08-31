/**
 * Flatten a TypeScript diagnostic message chain into one string.
 *
 * A compiler diagnostic carries its explanation as a nested chain rather than a
 * sentence, and every surface that shows one has to join it the same way. The
 * chain is described structurally here, so this package depends on nothing and
 * either compiler plane can pass its own diagnostic straight in.
 */

/** One diagnostic message and the chain explaining it. */
export interface DiagnosticMessage {
  /** This link's own text. */
  readonly text: string
  /** Nested explanations, outermost first; absent when the message stands alone. */
  readonly messageChain?: readonly DiagnosticMessage[] | undefined
}

/**
 * Join a diagnostic message and its chain into one string.
 * @param message - diagnostic, chain link, or an already-flat string.
 * @param separator - inserted between chain entries.
 * @returns the flattened message.
 */
export function flattenDiagnosticMessage(message: string | DiagnosticMessage, separator: string): string {
  if (typeof message === 'string') return message
  // Joining a lone text is that text, so an absent or empty chain needs no branch.
  const chain = message.messageChain ?? []
  return [message.text, ...chain.map(entry => flattenDiagnosticMessage(entry, separator))].join(separator)
}
