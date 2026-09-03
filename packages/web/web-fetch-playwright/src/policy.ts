/**
 * Destination admission policy for the Playwright fetch provider. Every destination a
 * rendered page reaches — main frame, subresource, each hop a redirect names, and each
 * WebSocket a page or frame opens — passes the shared fetch URL policy and must reach a
 * public unicast address. The provider feeds this policy from all three Playwright
 * channels those destinations arrive on; this module owns the decision, not the channel.
 * @module @deepseek-ai/dsh-web-fetch-playwright/policy
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { validateFetchUrl } from '@deepseek-ai/dsh-web-fetch-http/policy'
import { ipLiteralHostname, isPublicIpAddress, publicHttpNetwork } from '@deepseek-ai/dsh-web-fetch-http/network'
import type { RenderRoute, RenderSocketRoute } from './browser.ts'

/** Glob that matches every request a context issues, so none escapes the address policy. */
const INTERCEPT_EVERY_REQUEST = '**/*'

/** Chromium network error reported for a destination the address policy refuses. */
const REFUSED_BY_POLICY = 'blockedbyclient'

/** RFC 6455 close code for a connection an endpoint refuses on policy grounds. */
const SOCKET_POLICY_VIOLATION = 1008

/** Close reason the page reads when the address policy refuses a WebSocket. */
const SOCKET_REFUSED_REASON = 'refused by the web fetch destination policy'

/** The HTTP scheme each WebSocket scheme takes its destination rules from. */
const SOCKET_SCHEME_EQUIVALENT: Readonly<Record<string, string>> = { 'ws:': 'http:', 'wss:': 'https:' }

/**
 * Validate one WebSocket URL under the shared fetch URL policy. `ws:` and `wss:` reach
 * the same hosts as `http:` and `https:` and carry the same credential and length
 * rules, so the scheme is rewritten to its HTTP equivalent and validated there rather
 * than through a second copy of those rules.
 * @param raw - the absolute WebSocket URL as the browser reports it.
 * @returns the validated URL, carrying its HTTP-equivalent scheme.
 */
function validateSocketUrl(raw: string): URL {
  const parsed = URL.parse(raw)
  if (parsed === null) {
    throw new WebError(`invalid WebSocket URL: ${raw}`, 'WEB_INVALID_URL')
  }
  const equivalent = SOCKET_SCHEME_EQUIVALENT[parsed.protocol]
  if (equivalent === undefined) {
    throw new WebError(
      `unsupported WebSocket URL scheme "${parsed.protocol}" (only ws and wss are allowed)`,
      'WEB_INVALID_URL',
    )
  }
  parsed.protocol = equivalent
  return validateFetchUrl(parsed.href)
}

/**
 * The destination policy for one fetch. Every destination the page reaches — main frame,
 * subresource, each hop a redirect names, and each WebSocket a page or frame opens —
 * passes the shared fetch URL policy and must reach a public unicast address. One
 * decision is memoized per hostname for the life of the fetch, so a page load resolves
 * each host once, a refused host stays refused, and a redirect hop back to a host the
 * main frame already decided costs nothing. Chromium resolves the hostname again when it
 * connects, so this admits destinations rather than pinning them to the resolved
 * addresses.
 */
export class DestinationPolicy {
  private readonly decided = new Map<string, Promise<void>>()

  /** @param signal - the fetch deadline; it aborts a hostname resolution that outlives the fetch. */
  constructor(private readonly signal: AbortSignal) {}

  /**
   * Admit one request URL or throw the {@link WebError} that refuses it.
   * @param raw - the absolute request URL as the browser reports it.
   * @returns the parsed URL once scheme, credential, length, and address policy pass.
   */
  async admit(raw: string): Promise<URL> {
    const url = validateFetchUrl(raw)
    await this.decideOnce(url.hostname)
    return url
  }

  /**
   * Admit one WebSocket the page is opening, or throw the {@link WebError} that refuses
   * it. A WebSocket destination is decided by the same hostname rule as a request, and
   * shares the fetch's memo, so `wss://host` reuses the decision `https://host` made.
   * @param raw - the absolute WebSocket URL as the browser reports it.
   * @returns nothing once scheme, credential, length, and address policy pass.
   */
  async admitSocket(raw: string): Promise<void> {
    await this.decideOnce(validateSocketUrl(raw).hostname)
  }

  /** Reuse this fetch's decision for a hostname, or start and memoize the first one. */
  private decideOnce(hostname: string): Promise<void> {
    const pending = this.decided.get(hostname) ?? this.decide(hostname)
    this.decided.set(hostname, pending)
    return pending
  }

  /** Decide one hostname: an IP literal from the literal itself, a name through DNS. */
  private async decide(hostname: string): Promise<void> {
    const literal = ipLiteralHostname(hostname)
    if (literal !== undefined) {
      if (!isPublicIpAddress(literal)) {
        throw new WebError(`URL hostname "${hostname}" is a non-public IP address`, 'WEB_BLOCKED_URL')
      }
      return
    }
    await publicHttpNetwork.resolve(hostname, this.signal)
  }
}

/** Settle one value; rejections are rendered as text for the interceptor to read. */
const describe = (reason: Error | string): string => String(reason)

/**
 * Build the interceptor that decides every request one context issues. A handler that
 * threw would leave its request pending forever, so both the decision and the verdict
 * are settled rather than propagated.
 * @param policy - the fetch's destination policy.
 * @returns the route handler to install on the context.
 */
export function guardRequest(policy: DestinationPolicy): (route: RenderRoute) => Promise<void> {
  return async (route: RenderRoute): Promise<void> => {
    const admitted = await policy.admit(route.request().url()).then(
      () => true,
      describe,
    )
    await (admitted === true
      ? route.continue()
      : route.abort(REFUSED_BY_POLICY)
    ).then(
      () => undefined,
      describe,
    )
  }
}

/**
 * Build the interceptor that decides every WebSocket one context opens. Playwright
 * connects an unrouted WebSocket straight to its server, so this handler is the whole
 * of the address policy for `ws:` and `wss:` destinations. A handler that threw would
 * leave the connection pending forever, so both the decision and the refusal are
 * settled rather than propagated.
 * @param policy - the fetch's destination policy.
 * @returns the WebSocket handler to install on the context.
 */
export function guardSocket(policy: DestinationPolicy): (socket: RenderSocketRoute) => Promise<void> {
  return async (socket: RenderSocketRoute): Promise<void> => {
    const admitted = await policy.admitSocket(socket.url()).then(
      () => true,
      describe,
    )
    if (admitted === true) {
      socket.connectToServer()
      return
    }
    await socket.close({ code: SOCKET_POLICY_VIOLATION, reason: SOCKET_REFUSED_REASON }).then(
      () => undefined,
      describe,
    )
  }
}

/** The interceptor glob: match every request so none bypasses the policy. */
export const interceptEveryRequest = INTERCEPT_EVERY_REQUEST

/**
 * The WebSocket interceptor matcher: match every URL so no connection bypasses the
 * policy. Playwright matches WebSockets by URL, and a predicate leaves no glob
 * semantics between "every connection" and what the browser routes.
 * @returns true for every WebSocket URL the context opens.
 */
export const interceptEverySocket = (): boolean => true
