/** GitHub HTTP authentication, parsing, and fire-and-forget dispatch. */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Webhooks } from '@octokit/webhooks'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import {
  WebhookDeliveryId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
} from '@deepseek-ai/dsh-webhook'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { readBoundedUtf8Body, WebhookHttpError } from './body.ts'
import type { GitHubJsonObject } from './types.ts'

/** Handler values validated once at plugin load. */
export interface GitHubWebhookHandlerConfig {
  readonly source: string
  readonly secretEnv: CredentialRef
  readonly maxBodyBytes: number
}

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/** Require one unambiguous non-empty request header. */
function requiredHeader(request: IncomingMessage, name: string): string {
  const values = request.headersDistinct[name]
  const value = values?.[0]
  if (values?.length !== 1 || value === undefined || value.trim() === '') {
    throw new WebhookHttpError(400, `missing ${name} header`)
  }
  return value
}

/** Whether Content-Type names JSON with at most one UTF-8 charset parameter. */
function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false
  const parts = value.split(';').map(part => part.trim())
  const [mediaType, parameter, ...extra] = parts
  if (mediaType?.toLowerCase() !== 'application/json') return false
  if (parameter === undefined) return true
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter)
}

/** Send one empty or plain-text response exactly once. */
function respond(response: ServerResponse, status: number, message?: string): void {
  if (message === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/** Convert a parsed value into the adapter's generic signed-object guarantee. */
function parsePayload(body: string): GitHubJsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new WebhookHttpError(400, 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookHttpError(400, 'GitHub webhook payload must be a JSON object')
  }
  const snapshot = snapshotJsonValue(parsed)
  if (snapshot === undefined || typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new WebhookHttpError(400, 'GitHub webhook payload is not lossless JSON')
  }
  return snapshot
}

/** Answer one handler rejection without leaking request or secret text. */
function respondFailure(ctx: Context, response: ServerResponse, reason: Thrown): void {
  if (reason instanceof WebhookHttpError) {
    respond(response, reason.status, reason.message)
    return
  }
  ctx.logger.warn('webhook-github: request failed')
  respond(response, 503, 'webhook ingress is unavailable')
}

/** Dispatch in memory or refuse when the runtime is not accepting deliveries. */
function dispatchVerified(ctx: Context, delivery: VerifiedWebhookDelivery<'github'>): void {
  try {
    ctx.webhookRuntime.dispatch(delivery)
  } catch {
    ctx.logger.warn('webhook-github: dispatch unavailable')
    throw new WebhookHttpError(503, 'webhook runtime is unavailable')
  }
}

/** Authenticate one body and dispatch the signed delivery. */
function dispatchSignedBody(
  ctx: Context,
  config: GitHubWebhookHandlerConfig,
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
): Promise<void> {
  const signature = requiredHeader(request, 'x-hub-signature-256')
  const deliveryId = requiredHeader(request, 'x-github-delivery')
  const eventName = requiredHeader(request, 'x-github-event')
  return ctx.credentials.resolve(config.secretEnv).then((credential) => {
    if (credential === undefined || credential.value === '') {
      throw new WebhookHttpError(503, 'GitHub webhook secret is unavailable')
    }
    return new Webhooks({ secret: credential.value }).verify(body, signature).then(
      (verified) => {
        if (!verified) throw new WebhookHttpError(401, 'invalid webhook signature')
        const payload = parsePayload(body)
        dispatchVerified(ctx, {
          kind: 'github',
          source: WebhookSourceId(config.source),
          deliveryId: WebhookDeliveryId(deliveryId),
          event: { name: eventName, payload },
          receivedAt: Date.now(),
        })
        respond(response, 202)
      },
      (_reason: Thrown) => {
        throw new WebhookHttpError(401, 'invalid webhook signature')
      },
    )
  })
}

/**
 * Create one exact-route GitHub handler.
 * @param ctx - adapter context carrying credentials and webhook runtime.
 * @param config - validated source, credential reference, and body ceiling.
 * @returns an HTTP handler that answers after in-memory dispatch, never rule settlement.
 */
export function createGitHubWebhookHandler(
  ctx: Context,
  config: GitHubWebhookHandlerConfig,
): WebRoute['handler'] {
  return (request, response) => {
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      respond(response, 405, 'method not allowed')
      return
    }
    if (!isJsonContentType(request.headers['content-type'])) {
      respond(response, 415, 'content type must be application/json')
      return
    }
    return readBoundedUtf8Body(request, config.maxBodyBytes).then(
      body => dispatchSignedBody(ctx, config, request, response, body),
    ).then(undefined, (reason: Thrown) => {
      respondFailure(ctx, response, reason)
    })
  }
}
