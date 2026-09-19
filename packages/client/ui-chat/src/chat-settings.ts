/** Chat transcript preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the Chat target. */
export const CHAT_SETTINGS_NAMESPACE = 'ui-chat'

/** Field carrying the completed-Turn transcript presentation mode. */
export const TRANSCRIPT_VIEW_FIELD = 'transcriptView'

/** Transcript presentation modes accepted at settings boundaries. */
export const TRANSCRIPT_VIEW_MODES = ['normal', 'compact'] as const

/** Completed-Turn transcript presentation. */
export type TranscriptViewMode = typeof TRANSCRIPT_VIEW_MODES[number]

/** Default preserves the compact process disclosure introduced by Chat. */
export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = 'compact'

/** Durable Chat section shared by the Host schema and browser scope. */
export interface ChatSettings {
  /** Presentation mode for completed Turn process content. */
  transcriptView: TranscriptViewMode
}

/** Durable Chat schema; also the wire envelope the browser scope validates against. */
export const ChatSettingsSchema: z<ChatSettings> = z.object({
  [TRANSCRIPT_VIEW_FIELD]: z.union([...TRANSCRIPT_VIEW_MODES]).default(DEFAULT_TRANSCRIPT_VIEW_MODE),
})

/**
 * Claim a transcript presentation token.
 * @param value - wire or menu token.
 * @returns whether the token is a configured transcript view mode.
 */
export function isTranscriptViewMode(value: unknown): value is TranscriptViewMode {
  return value === 'normal' || value === 'compact'
}

/**
 * Claim one wire section as the durable chat settings type.
 * @param section - Host-served namespace value.
 * @returns the claimed section, or undefined when the section is not chat settings.
 */
export function decodeChatSettings(section: unknown): ChatSettings | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const transcriptView = Reflect.get(section, TRANSCRIPT_VIEW_FIELD)
  if (!isTranscriptViewMode(transcriptView)) return undefined
  return { transcriptView }
}
