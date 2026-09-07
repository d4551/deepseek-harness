/**
 * The stable Remote failure vocabulary of the preset roster: every preset
 * rejection a wire caller can act on maps to one code and its details here,
 * so the service methods only name the operation that failed.
 * @module @deepseek-ai/dsh-agent-presets/remote-failures
 */

import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { InvalidPresetIdError, PresetExistsError, PresetNotWritableError } from './authoring.ts'
import { PresetLockedError, PresetMountError, UnknownPresetError } from './preset.ts'
import type { AgentPresetErrorDetailsMap } from './types.ts'

/**
 * Construct one typed preset failure for the Remote carrier.
 * @param code - the stable failure code a caller discriminates on.
 * @param message - operator-facing description.
 * @param details - the payload this code carries.
 * @returns the failure to throw across the Remote boundary.
 */
export function remotePresetFailure<Code extends keyof AgentPresetErrorDetailsMap>(
  code: Code,
  message: string,
  details: AgentPresetErrorDetailsMap[Code],
): TypertRemoteFailure {
  return new TypertRemoteFailure({ code, message, details })
}

/**
 * Map one preset rejection to its stable Remote code and details.
 * @param error - the rejection a roster operation produced.
 * @param agentPreset - the preset id the operation was about.
 * @returns the typed failure, or `undefined` for a rejection outside the preset vocabulary.
 */
export function presetFailure(error: object | string | undefined, agentPreset: string): TypertRemoteFailure | undefined {
  if (error instanceof UnknownPresetError) {
    return remotePresetFailure(
      'agent-preset-not-found',
      error.message,
      { agentPreset: error.presetId, available: [...error.available] },
    )
  }
  if (error instanceof PresetMountError) {
    return remotePresetFailure(
      'agent-preset-invalid',
      error.message,
      { agentPreset: error.presetId, reason: error.reason },
    )
  }
  if (error instanceof InvalidPresetIdError || error instanceof PresetExistsError) {
    return remotePresetFailure(
      'agent-preset-invalid',
      error.message,
      { agentPreset: error.presetId, reason: error.message },
    )
  }
  if (error instanceof PresetNotWritableError) {
    return remotePresetFailure(
      'agent-preset-read-only',
      error.message,
      { agentPreset, reason: error.message },
    )
  }
  if (error instanceof PresetLockedError) {
    return remotePresetFailure(
      'agent-preset-locked',
      `session "${error.sessionId}" has already started; its agent preset is fixed`,
      { sessionId: error.sessionId, agentPreset: error.presetId },
    )
  }
  return undefined
}

/**
 * Refuse an empty preset id before invoking a domain operation.
 * @param value - the wire-supplied id.
 * @param field - which request field carried it, for the failure message.
 * @throws {TypertRemoteFailure} `bad-request` when the id is empty.
 */
export function validatePresetId(value: string, field: 'agentPreset' | 'from'): void {
  if (value.length === 0) {
    throw remotePresetFailure('bad-request', `${field} must be a non-empty string`, {})
  }
}

/**
 * Throw the stable preset failure for `error`, or the caller's operation-specific `internal` failure.
 * @param error - the rejection a roster operation produced.
 * @param agentPreset - the preset id the operation was about.
 * @param internalMessage - the message for a rejection outside the preset vocabulary.
 * @throws {TypertRemoteFailure} always.
 */
export function rejectPreset(error: object | string | undefined, agentPreset: string, internalMessage: string): never {
  throw presetFailure(error, agentPreset) ?? remotePresetFailure('internal', internalMessage, {})
}
