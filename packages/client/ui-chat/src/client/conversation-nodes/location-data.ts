import type { AssistantChatData, FinalAssistantChatData, TurnTailChatData } from '../contract/chat-nodes.ts'
import type { TurnProcessSignature } from '../contract/turn-process.ts'

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function isAssistantChatData(value: unknown): value is AssistantChatData {
  if (!isRecord(value)) return false
  const status: unknown = Reflect.get(value, 'status')
  const turn: unknown = Reflect.get(value, 'turn')
  const step: unknown = Reflect.get(value, 'step')
  const blocks: unknown = Reflect.get(value, 'blocks')
  const time: unknown = Reflect.get(value, 'time')
  return (status === 'running' || status === 'settled' || status === 'interrupted')
    && typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0
    && typeof step === 'number' && Number.isSafeInteger(step) && step >= 0
    && Array.isArray(blocks)
    && typeof time === 'number' && Number.isSafeInteger(time)
}

function isFinalAssistantChatData(value: unknown): value is FinalAssistantChatData {
  return isAssistantChatData(value) && Reflect.get(value, 'finalNode') !== undefined
}

function isTurnTailChatData(value: unknown): value is TurnTailChatData {
  if (!isRecord(value)) return false
  const turn: unknown = Reflect.get(value, 'turn')
  const seq: unknown = Reflect.get(value, 'seq')
  const time: unknown = Reflect.get(value, 'time')
  const closing: unknown = Reflect.get(value, 'closing')
  const branchUnavailable: unknown = Reflect.get(value, 'branchUnavailable')
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0
    && typeof seq === 'number' && Number.isSafeInteger(seq)
    && typeof time === 'number' && Number.isSafeInteger(time)
    && typeof branchUnavailable === 'boolean'
    && (closing === null || isFinalAssistantChatData(closing))
}

/** Read a Turn-process signature published on Location data. */
export function publishedTurnProcess(value: unknown): TurnProcessSignature | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError('turn-process Location data is not a signature')
  return value
}

/** Read Assistant step data published on Location data. */
export function publishedAssistantStep(value: unknown): AssistantChatData | undefined {
  if (value === undefined) return undefined
  if (!isAssistantChatData(value)) throw new TypeError('assistant-step Location data is not AssistantChatData')
  return value
}

/** Read Turn-tail data published on Location data. */
export function publishedTurnTail(value: unknown): TurnTailChatData | undefined {
  if (value === undefined) return undefined
  if (!isTurnTailChatData(value)) throw new TypeError('turn-tail Location data is not TurnTailChatData')
  return value
}
