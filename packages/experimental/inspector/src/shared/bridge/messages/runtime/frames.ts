/** Versioned envelopes for Worker-to-Client Runtime operations. */

import type {
  ClientRuntimeRequestId,
  ClientRuntimeSessionId,
  InspectorSourceGeneration,
  InspectorSourceId,
} from '../../ids.ts'
import { isPlainObject } from '../../../json.ts'
import { exactKeys, exactObject, wireId } from '../../../validation.ts'
import { INSPECTOR_PROTOCOL_VERSION } from '../../version.ts'
import { parseClientRuntimeCommand } from './command-codec.ts'
import { parseClientRuntimeResult } from './value-codec.ts'
import type { ClientRuntimeCommand, ClientRuntimeError, ClientRuntimeResult } from './commands.ts'

/** Source capability that permits synthetic Runtime execution contexts. */
export interface ClientRuntimeCapability {
  readonly type: 'client-runtime'
  readonly origin: string
}

/** Worker request for one operation in a specific source generation and DevTools session. */
export interface ClientRuntimeRequestFrame {
  readonly v: typeof INSPECTOR_PROTOCOL_VERSION
  readonly t: 'client-runtime/request'
  readonly sourceId: InspectorSourceId
  readonly generation: InspectorSourceGeneration
  readonly sessionId: ClientRuntimeSessionId
  readonly requestId: ClientRuntimeRequestId
  readonly command: ClientRuntimeCommand
}

/** Worker cancellation of one outstanding Client Runtime request. */
export interface ClientRuntimeCancelFrame {
  readonly v: typeof INSPECTOR_PROTOCOL_VERSION
  readonly t: 'client-runtime/cancel'
  readonly sourceId: InspectorSourceId
  readonly generation: InspectorSourceGeneration
  readonly sessionId: ClientRuntimeSessionId
  readonly requestId: ClientRuntimeRequestId
}

/** Worker acknowledgement that commits one successful Client Runtime response. */
export interface ClientRuntimeResponseAcknowledgedFrame {
  readonly v: typeof INSPECTOR_PROTOCOL_VERSION
  readonly t: 'client-runtime/response-acknowledged'
  readonly sourceId: InspectorSourceId
  readonly generation: InspectorSourceGeneration
  readonly sessionId: ClientRuntimeSessionId
  readonly requestId: ClientRuntimeRequestId
}

/** Client response to one typed Runtime request. */
export interface ClientRuntimeResponseFrame {
  readonly v: typeof INSPECTOR_PROTOCOL_VERSION
  readonly t: 'client-runtime/response'
  readonly sourceId: InspectorSourceId
  readonly generation: InspectorSourceGeneration
  readonly sessionId: ClientRuntimeSessionId
  readonly requestId: ClientRuntimeRequestId
  readonly outcome:
    | { readonly ok: true; readonly result: ClientRuntimeResult }
    | { readonly ok: false; readonly error: ClientRuntimeError }
}

/** One-way cleanup when a DevTools connection or its Runtime domain closes. */
export interface ClientRuntimeSessionClosedFrame {
  readonly v: typeof INSPECTOR_PROTOCOL_VERSION
  readonly t: 'client-runtime/session-closed'
  readonly sourceId: InspectorSourceId
  readonly generation: InspectorSourceGeneration
  readonly sessionId: ClientRuntimeSessionId
}

/**
 * Parse and rebuild a Client Runtime capability.
 * @param value - Untrusted capability declaration.
 * @returns The validated capability.
 */
export function parseClientRuntimeCapability(value: unknown): ClientRuntimeCapability {
  const record = exactObject(value, ['type', 'origin'], 'Client Runtime capability')
  if (record.type !== 'client-runtime' || typeof record.origin !== 'string' || record.origin.length > 2_048) {
    throw new Error('inspector protocol: invalid Client Runtime capability')
  }
  return { type: 'client-runtime', origin: record.origin }
}

/**
 * Parse and rebuild one Worker-to-Client Runtime request.
 * @param value - Untrusted request frame.
 * @returns The validated request frame.
 */
export function parseClientRuntimeRequestFrame(value: Record<string, unknown>): ClientRuntimeRequestFrame {
  assertFrameEnvelope(value, 'client-runtime/request', [...REQUEST_ADDRESSED_KEYS, 'command'], 'Client Runtime request')
  return {
    v: INSPECTOR_PROTOCOL_VERSION,
    t: 'client-runtime/request',
    ...parseFrameAddress(value),
    requestId: wireId<'ClientRuntimeRequestId'>(value.requestId, 'requestId'),
    command: parseClientRuntimeCommand(value.command),
  }
}

/**
 * Parse and rebuild one Worker-to-Client Runtime cancellation.
 * @param value - Untrusted cancellation frame.
 * @returns The validated cancellation frame.
 */
export function parseClientRuntimeCancelFrame(value: Record<string, unknown>): ClientRuntimeCancelFrame {
  return parseRequestAddressedFrame(value, 'client-runtime/cancel', 'Client Runtime cancellation')
}

/**
 * Parse and rebuild one Worker acknowledgement for a Client Runtime response.
 * @param value - Untrusted acknowledgement frame.
 * @returns The validated acknowledgement frame.
 */
export function parseClientRuntimeResponseAcknowledgedFrame(
  value: Record<string, unknown>,
): ClientRuntimeResponseAcknowledgedFrame {
  return parseRequestAddressedFrame(
    value,
    'client-runtime/response-acknowledged',
    'Client Runtime response acknowledgement',
  )
}

/**
 * Parse and rebuild one Client-to-Worker Runtime response.
 * @param value - Untrusted response frame.
 * @returns The validated response frame.
 */
export function parseClientRuntimeResponseFrame(value: Record<string, unknown>): ClientRuntimeResponseFrame {
  assertFrameEnvelope(value, 'client-runtime/response', [...REQUEST_ADDRESSED_KEYS, 'outcome'], 'Client Runtime response')
  return {
    v: INSPECTOR_PROTOCOL_VERSION,
    t: 'client-runtime/response',
    ...parseFrameAddress(value),
    requestId: wireId<'ClientRuntimeRequestId'>(value.requestId, 'requestId'),
    outcome: parseOutcome(value.outcome),
  }
}

/**
 * Parse and rebuild one Runtime-session cleanup notification.
 * @param value - Untrusted cleanup frame.
 * @returns The validated cleanup frame.
 */
export function parseClientRuntimeSessionClosedFrame(value: Record<string, unknown>): ClientRuntimeSessionClosedFrame {
  const keys = REQUEST_ADDRESSED_KEYS.filter(key => key !== 'requestId')
  assertFrameEnvelope(value, 'client-runtime/session-closed', keys, 'Client Runtime session close')
  return {
    v: INSPECTOR_PROTOCOL_VERSION,
    t: 'client-runtime/session-closed',
    ...parseFrameAddress(value),
  }
}

/** The exact field set of a frame addressed to one outstanding request. */
const REQUEST_ADDRESSED_KEYS = ['v', 't', 'sourceId', 'generation', 'sessionId', 'requestId'] as const

/**
 * Rebuild the routing identifiers every Client Runtime frame carries.
 * @param value - Frame whose envelope has already been accepted.
 * @returns The branded source, generation, and DevTools session identifiers.
 */
function parseFrameAddress(value: Record<string, unknown>): {
  sourceId: InspectorSourceId
  generation: InspectorSourceGeneration
  sessionId: ClientRuntimeSessionId
} {
  return {
    sourceId: wireId<'InspectorSourceId'>(value.sourceId, 'sourceId'),
    generation: wireId<'InspectorSourceGeneration'>(value.generation, 'generation'),
    sessionId: wireId<'ClientRuntimeSessionId'>(value.sessionId, 'sessionId'),
  }
}

/**
 * Reject a frame whose field set, protocol version, or tag does not match.
 * @param value - Untrusted frame.
 * @param tag - Exact `t` discriminant this frame must carry.
 * @param keys - Complete field allowlist for this frame.
 * @param label - Frame name used in validation errors.
 */
function assertFrameEnvelope(
  value: Record<string, unknown>,
  tag: string,
  keys: readonly string[],
  label: string,
): void {
  exactKeys(value, keys, label)
  if (value.v !== INSPECTOR_PROTOCOL_VERSION || value.t !== tag) {
    throw new Error(`inspector protocol: invalid ${label} envelope`)
  }
}

/**
 * Parse one frame that names a single outstanding request and carries nothing
 * else. Cancellation and response acknowledgement differ only by tag, so both
 * are rebuilt here rather than spelled out twice.
 * @param value - Untrusted frame.
 * @param tag - Exact `t` discriminant this frame must carry.
 * @param label - Frame name used in validation errors.
 * @returns The validated envelope, routing identifiers, and request id.
 */
function parseRequestAddressedFrame<
  Tag extends ClientRuntimeCancelFrame['t'] | ClientRuntimeResponseAcknowledgedFrame['t'],
>(value: Record<string, unknown>, tag: Tag, label: string): {
  readonly v: typeof INSPECTOR_PROTOCOL_VERSION
  readonly t: Tag
  readonly sourceId: InspectorSourceId
  readonly generation: InspectorSourceGeneration
  readonly sessionId: ClientRuntimeSessionId
  readonly requestId: ClientRuntimeRequestId
} {
  assertFrameEnvelope(value, tag, REQUEST_ADDRESSED_KEYS, label)
  return {
    v: INSPECTOR_PROTOCOL_VERSION,
    t: tag,
    ...parseFrameAddress(value),
    requestId: wireId<'ClientRuntimeRequestId'>(value.requestId, 'requestId'),
  }
}

function parseOutcome(value: unknown): ClientRuntimeResponseFrame['outcome'] {
  if (!isPlainObject(value) || typeof value.ok !== 'boolean') {
    throw new Error('inspector protocol: invalid Client Runtime outcome')
  }
  if (value.ok) {
    exactKeys(value, ['ok', 'result'], 'successful Client Runtime outcome')
    return { ok: true, result: parseClientRuntimeResult(value.result) }
  }
  exactKeys(value, ['ok', 'error'], 'failed Client Runtime outcome')
  const error = exactObject(value.error, ['code', 'message'], 'Client Runtime error')
  if (!ERROR_CODES.has(error.code as ClientRuntimeError['code']) || typeof error.message !== 'string') {
    throw new Error('inspector protocol: invalid Client Runtime error')
  }
  return { ok: false, error: { code: error.code as ClientRuntimeError['code'], message: error.message } }
}

const ERROR_CODES = new Set<ClientRuntimeError['code']>([
  'invalid-request', 'object-not-found', 'unsupported', 'timeout', 'result-too-large', 'internal-error',
])
