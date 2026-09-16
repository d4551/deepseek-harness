/** Complete durable image-reference identity. @module @deepseek-ai/dsh-attachment/ref-key */

import type { ImageAttachmentRef } from './types.ts'

/**
 * Identify references whose verification and returned metadata can be shared.
 * @param ref - complete durable image reference.
 * @returns an ordered encoding independent of object property insertion order.
 */
export function imageAttachmentRefKey(ref: ImageAttachmentRef): string {
  return JSON.stringify([
    ref.attachmentId,
    ref.mediaType,
    ref.bytes,
    ref.width,
    ref.height,
    ref.name,
    ref.originalDimensions?.width,
    ref.originalDimensions?.height,
  ])
}
