/** Busy-Enter preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for plain Enter while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/** Busy-Enter behaviors accepted at settings and input boundaries. */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of plain Enter while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/**
 * Claim a busy-Enter behavior token.
 * @param id - menu or settings identifier.
 * @returns the portable behavior.
 * @throws {Error} when the token is not a configured busy-Enter behavior.
 */
export function requireBusyEnterBehavior(id: string): BusyEnterBehavior {
  if (id === 'queue' || id === 'steer') return id
  throw new Error(`unreachable busy-enter behavior: ${id}`)
}

/** Default preserves Enter-as-Queue for running conversations. */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/** Durable conversation section shared by the Host schema and the browser scope. */
export interface ConversationSettings {
  /** Delivery mode for plain Enter while the addressed agent is busy. */
  busyEnter: BusyEnterBehavior
}

/** Durable conversation schema; also the wire envelope the browser scope validates against. */
export const ConversationSettingsSchema: z<ConversationSettings> = z.object({
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
})

/**
 * Claim a busy-Enter token without throwing.
 * @param value - wire or menu token.
 * @returns whether the token is a configured busy-Enter behavior.
 */
export function isBusyEnterBehavior(value: unknown): value is BusyEnterBehavior {
  return value === 'queue' || value === 'steer'
}

/**
 * Claim one wire section as the durable conversation settings type.
 * @param section - Host-served namespace value.
 * @returns the claimed section, or undefined when the section is not conversation settings.
 */
export function decodeConversationSettings(section: unknown): ConversationSettings | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const busyEnter = Reflect.get(section, BUSY_ENTER_FIELD)
  if (!isBusyEnterBehavior(busyEnter)) return undefined
  return { busyEnter }
}
