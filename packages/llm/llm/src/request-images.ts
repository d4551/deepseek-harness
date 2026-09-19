/** Verified request-image materialization. @module @deepseek-ai/dsh-llm/request-images */

import { imageAttachmentRefKey } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId, AttachmentStore, ImageAttachmentRef, ImageRequestPolicy, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Message } from './message.ts'
import type { ContentBlock } from './types.ts'

/** Values a Promise reject arm from request-image verification may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

function collectImageRefs(blocks: readonly ContentBlock[], refs: Map<string, ImageAttachmentRef>): void {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(imageAttachmentRefKey(block.attachment), block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/**
 * Verify every distinct reference before publishing images for serialization.
 * Exact repeated references share preparation; references to the same object
 * with different metadata each undergo verification. All started reads settle
 * before this operation returns or reports a failure.
 * @param messages - request messages after conservative image offload.
 * @param attachments - durable provider that verifies and projects image bytes.
 * @param policy - image policy captured for the dispatching model route.
 * @param signal - cancellation for the complete preparation operation.
 * @returns verified request versions indexed by immutable attachment identity.
 */
export async function prepareRequestImages(
  messages: readonly Message[],
  attachments: AttachmentStore,
  policy: ImageRequestPolicy,
  signal?: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  signal?.throwIfAborted()
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  const outcomes = await Promise.allSettled([...refs.values()].map(async ref => ({
    ref,
    version: await attachments.readImageRequest(ref, policy, signal),
  })))
  signal?.throwIfAborted()
  const versions = new Map<AttachmentId, RequestImageAttachment>()
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      const reason: Thrown = outcome.reason
      throw reason
    }
    versions.set(outcome.value.ref.attachmentId, outcome.value.version)
  }
  return versions
}
