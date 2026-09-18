/**
 * Session half of the high-level run API: `HarnessSession.run` sends a prompt
 * and settles when the whole agent next becomes idle, plus the wire-envelope
 * validators and final-response fold it reads through. The owning
 * `DeepSeekHarness` lives on the package entry.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import { assertSessionEventObject, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { createProcessHarnessClient, isRecord, SdkProtocolError } from './client.ts'
import { DeepSeekHarness } from './index.ts'
import type { RuntimeProcessOptions } from './launch.ts'
import type { ContentBlock, DeepSeekHarnessOptions, HarnessNotification, RunResult, SdkPromptContentBlock } from './types.ts'

/** Construct the high-level API against a generic process for package-local fake-runtime tests. */
export function createProcessDeepSeekHarness(
  runtime: RuntimeProcessOptions,
  options: DeepSeekHarnessOptions = {},
): DeepSeekHarness {
  return new DeepSeekHarness({
    ...runtime.cwd === undefined ? {} : { processCwd: runtime.cwd },
    ...options,
  }, () => createProcessHarnessClient(runtime))
}

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * One SDK session: a stable id plus owned activity intervals.
 */
export class HarnessSession {
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string) {}

  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(input: string | SdkPromptContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult> {
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // Wire boundary: the envelope feeds the typed RunResult, so a
        // malformed runtime surfaces as a protocol error, not as type-invalid
        // data (or a TypeError out of finalResponse).
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    try {
      const messageId = await client.prompt(this.id, contentBlocks)
      let received = false
      while (true) {
        const notification = await subscription.next()
        if (!received) {
          if (notification.method !== 'session.event'
            || notification.params.sessionId !== this.id
            || !isInboxReceipt(notification.params.event, messageId)) continue
          received = true
        }
        collect(notification)
        if (notification.method === 'session.status'
          && notification.params.sessionId === this.id
          && notification.params.status === 'idle') break
      }
    } finally {
      subscription.close()
    }

    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      events,
      notifications,
    }
  }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | SdkPromptContentBlock[]): SdkPromptContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/** Reject a wire turn-end reason that is not a kind-tagged envelope. */
function assertWireTurnEndReason(value: unknown): void {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new SdkProtocolError(`turn/end carried no reason envelope: ${JSON.stringify(value)}`)
  }
  if (value.kind !== 'aborted') return
  if (!isRecord(value.reason) || typeof value.reason.kind !== 'string') {
    throw new SdkProtocolError(`turn/end carried a malformed aborted reason: ${JSON.stringify(value)}`)
  }
  switch (value.reason.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
    case 'legacy':
      return
    case 'hook':
      if (typeof value.reason.reason !== 'string') {
        throw new SdkProtocolError(`turn/end carried a malformed hook abort reason: ${JSON.stringify(value)}`)
      }
      return
    default:
      throw new SdkProtocolError(`turn/end carried an unknown abort reason: ${JSON.stringify(value)}`)
  }
}

/** Validate the fields in a wire `session.event` envelope before returning the typed result. */
function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string'
    || typeof value.seq !== 'number'
    || typeof value.time !== 'number' || !Number.isSafeInteger(value.time)
    || !('data' in value)) {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  assertSessionEventObject(value)
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  if (value.type === 'turn/end') {
    assertWireTurnEndReason(value.data.reason)
  }
  return value
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
