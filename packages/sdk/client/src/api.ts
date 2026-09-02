/**
 * Session half of the high-level run API: `HarnessSession.run` sends a prompt
 * and settles when the whole agent next becomes idle, plus the wire-envelope
 * validators and final-response fold it reads through. The owning
 * `DeepSeekHarness` lives on the package entry.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { createProcessHarnessClient, HarnessClient, isRecord, SdkProtocolError } from './client.ts'
import { DeepSeekHarness } from './index.ts'
import type { RuntimeProcessOptions } from './launch.ts'
import type { ContentBlock, DeepSeekHarnessOptions, HarnessNotification, RunResult, SdkPromptContentBlock } from './types.ts'

/** Construct the high-level API against a generic process for package-local fake-runtime tests. */
export function createProcessDeepSeekHarness(
  runtime: RuntimeProcessOptions,
  options: DeepSeekHarnessOptions = {},
): DeepSeekHarness {
  const Constructor = DeepSeekHarness as unknown as new (
    publicOptions: DeepSeekHarnessOptions,
    clientFactory: () => HarnessClient,
  ) => DeepSeekHarness
  return new Constructor({
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

/** Validate the provider-read fields of one wire turn-end reason. */
function validatedTurnEndReason(value: unknown): TurnEndReason {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new SdkProtocolError(`turn/end carried no reason envelope: ${JSON.stringify(value)}`)
  }
  if (value.kind === 'aborted') {
    if (!isRecord(value.reason) || typeof value.reason.kind !== 'string') {
      throw new SdkProtocolError(`turn/end carried a malformed aborted reason: ${JSON.stringify(value)}`)
    }
    switch (value.reason.kind) {
      case 'user':
      case 'parent':
      case 'disposed':
      case 'legacy':
        break
      case 'hook':
        if (typeof value.reason.reason !== 'string') {
          throw new SdkProtocolError(`turn/end carried a malformed hook abort reason: ${JSON.stringify(value)}`)
        }
        break
      default:
        throw new SdkProtocolError(`turn/end carried an unknown abort reason: ${JSON.stringify(value)}`)
    }
  }
  return value as unknown as TurnEndReason
}

/** Validate the fields in a wire `session.event` envelope before returning the typed result. */
function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // The one variant this module reads into (finalResponse) must carry
  // kind-tagged content blocks; other variants pass through under their
  // envelope shape.
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  if (value.type === 'turn/end') {
    const data = isRecord(value.data) ? value.data : undefined
    if (data === undefined) {
      throw new SdkProtocolError(`turn/end event carried malformed data: ${JSON.stringify(value)}`)
    }
    validatedTurnEndReason(data.reason)
  }
  return value as unknown as SessionEvent
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
