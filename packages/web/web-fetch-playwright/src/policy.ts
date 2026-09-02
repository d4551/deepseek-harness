/**
 * Destination admission policy for the Playwright fetch provider. Every request a
 * rendered page issues — main frame, subresource, and each redirect hop — passes the
 * shared fetch URL policy and must reach a public unicast address.
 * @module @deepseek-ai/dsh-web-fetch-playwright/policy
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { validateFetchUrl } from '@deepseek-ai/dsh-web-fetch-http/policy'
import { ipLiteralHostname, isPublicIpAddress, publicHttpNetwork } from '@deepseek-ai/dsh-web-fetch-http/network'
import type { RenderRoute } from './browser.ts'

/** Glob that matches every request a context issues, so none escapes the address policy. */
const INTERCEPT_EVERY_REQUEST = '**/*'

/** Chromium network error reported for a destination the address policy refuses. */
const REFUSED_BY_POLICY = 'blockedbyclient'

/**
 * The destination policy for one fetch. Every request the page issues — main frame,
 * subresource, and each redirect hop Chromium follows — passes the shared fetch URL
 * policy and must reach a public unicast address. One decision is memoized per
 * hostname for the life of the fetch, so a page load resolves each host once and a
 * refused host stays refused. Chromium resolves the hostname again when it connects,
 * so this admits destinations rather than pinning them to the resolved addresses.
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
    const pending = this.decided.get(url.hostname) ?? this.decide(url.hostname)
    this.decided.set(url.hostname, pending)
    await pending
    return url
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

/** The interceptor glob: match every request so none bypasses the policy. */
export const interceptEveryRequest = INTERCEPT_EVERY_REQUEST
