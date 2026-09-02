/**
 * Build-time packer for the browser runtime's VFS image.
 *
 * This entry owns the wrapper contract packed bodies are emitted against and
 * the image-entry types the pack pass consumes. One transform serves both
 * sides — the pack pass lowers with the runtime's own `lowerModuleSource`,
 * never a reimplementation — and the image records the contract version it was
 * lowered against. Bodies emitted against a different wrapper contract are
 * refused at mount time rather than half-working at run time.
 *
 * The pack pass itself lives in `./pack.ts` and the repository knowledge it
 * consumes in `./repository.ts`; both are reached at their own modules.
 * @module @deepseek-ai/dsh-experimental-webworker-packer
 */
import { LOWERING_VERSION } from '@deepseek-ai/dsh-experimental-webworker-runtime'

/** Image entries, keyed by their path relative to the virtual root. */
export type ImageFiles = Record<string, Uint8Array>

/** Wrapper contract the packed bodies are emitted against. */
export const WRAPPER_CONTRACT: string = LOWERING_VERSION

/** What one pack-time transform pass did. */
export interface TransformOutcome {
  /** JavaScript entries visited. */
  readonly visited: number
  /** How many changed; the rest were already in final form. */
  readonly rewritten: number
}
