/**
 * Real-Playwright suite: the launch, probe, and install-command entries that speak to
 * the `playwright` package, plus the WebSocket and redirect routing this provider's
 * address policy depends on, exercised against a live Chromium rather than a port fake.
 * @module web-fetch-playwright-chromium-spec
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from 'playwright'
import { publicHttpNetwork } from '@deepseek-ai/dsh-web-fetch-http/network'
import {
  chromiumAccess,
  chromiumExecutablePath,
  chromiumInstallCommand,
  guardSocket,
  interceptEveryRequest,
  interceptEverySocket,
  launchChromium,
  playwrightInstallCommand,
  probeChromium,
  probeExecutable,
  DestinationPolicy,
  PlaywrightFetchProvider,
} from '../src/provider.ts'
import type { BrowserAccess, ModuleResolver, RenderBrowser } from '../src/provider.ts'
import { limits } from './fakes.ts'

const require = createRequire(import.meta.url)
const playwrightManifest = require.resolve('playwright/package.json')
const playwrightDir = dirname(playwrightManifest)

/** The hostname the redirect fixture's browser resolves to loopback. */
const FIXTURE_HOST = 'fixture.test'

/** One redirect fixture: `/start` answers 302, every other path answers a page. */
interface RedirectFixture {
  /** The loopback port the fixture listens on. */
  readonly port: number
  /** Stop the fixture. */
  close(): Promise<void>
}

/**
 * Start a loopback server whose `/start` redirects to `location`.
 * @param location - the `Location` header `/start` answers with, given the bound port.
 * @returns the running fixture.
 */
async function redirectFixture(location: (port: number) => string): Promise<RedirectFixture> {
  const server: Server = createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: location((server.address() as AddressInfo).port) })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><body>content behind the redirect</body></html>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve()
      })
    }),
  }
}

/** The executable a launch would run, and whether this host has it installed. */
const executable = await chromiumExecutablePath()
const installed = existsSync(executable)

/** One browser for the whole suite; the launch itself is the first assertion. */
let shared: Browser | undefined

afterAll(async () => {
  await shared?.close()
})

describe('Playwright browser access', () => {
  it('names an install command that runs this package\'s own resolved CLI', () => {
    const command = chromiumInstallCommand()
    // A workspace install keeps `playwright` out of the repository root, so a bare
    // `playwright install chromium` is not runnable where this message is read.
    const manifest = JSON.parse(readFileSync(playwrightManifest, 'utf8')) as { bin: { playwright: string } }
    const cli = join(playwrightDir, manifest.bin.playwright)
    expect(existsSync(cli)).toBe(true)
    expect(command).toBe(`"${process.execPath}" "${cli}" install chromium`)
  })

  it('names the package as well as the browser when playwright itself is missing', () => {
    const uninstalled: ModuleResolver = () => {
      // What Node's resolver throws for a package that is not installed. `playwright`
      // is a peer dependency, so a deployment reaches this while mounting the plugin.
      throw Object.assign(new Error("Cannot find package 'playwright'"), { code: 'MODULE_NOT_FOUND' })
    }
    // Downloading the browser alone would leave the provider unable to launch it.
    expect(playwrightInstallCommand(uninstalled)).toBe('npm install playwright && npx playwright install chromium')
    // Every caller sits on a failure path a missing `playwright` produces — the plugin's
    // apply-time warning among them — so the command itself must never throw.
    expect(() => chromiumInstallCommand()).not.toThrow()
  })

  it('resolves the Chromium executable path from the installation', async () => {
    expect(executable.length).toBeGreaterThan(0)
    expect(executable.startsWith('/') || /^[A-Za-z]:\\/.test(executable)).toBe(true)
  })

  it('probes the installation by checking the executable, not by launching one', async () => {
    const answer = await probeChromium().then(() => 'installed', () => 'missing')
    expect(answer).toBe(installed ? 'installed' : 'missing')
    expect(chromiumAccess.probe).toBe(probeChromium)
    expect(chromiumAccess.launch).toBe(launchChromium)
  })

  it('rejects when the located executable is absent and resolves when it is present', async () => {
    await expect(probeExecutable(async () => join(playwrightDir, 'no-such-browser'))).rejects
      .toThrow(/no browser executable at /)
    await expect(probeExecutable(async () => playwrightManifest)).resolves.toBeUndefined()
  })

  it('launches a headless browser when one is installed', async () => {
    if (!installed) {
      // Without an installation the launcher must fail rather than hang; the message
      // is Playwright's own, and the provider appends the install command to it.
      await expect(launchChromium()).rejects.toThrow()
      return
    }
    shared = await launchChromium() as Browser
    const context = await shared.newContext({ userAgent: 'test-agent/1.0', serviceWorkers: 'block' })
    expect(context.pages()).toEqual([])
    await context.close()
  })
})

describe.skipIf(!installed)('Playwright redirect routing', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('reports a redirect hop to the request observer and to no interceptor', async () => {
    const browser = shared
    if (browser === undefined) throw new Error('the shared browser was never launched')
    const fixture = await redirectFixture(() => '/internal')
    const start = `http://127.0.0.1:${String(fixture.port)}/start`
    const internal = `http://127.0.0.1:${String(fixture.port)}/internal`

    const context = await browser.newContext({ userAgent: 'test-agent/1.0', serviceWorkers: 'block' })
    const routed: string[] = []
    const reported: { url: string; from: string | null }[] = []
    context.on('request', (request) => {
      reported.push({ url: request.url(), from: request.redirectedFrom()?.url() ?? null })
    })
    await context.route(interceptEveryRequest, async (route) => {
      routed.push(route.request().url())
      await route.continue()
    })
    const page = await context.newPage()
    const navigation = await page.goto(start, { waitUntil: 'domcontentloaded' })

    // Filtered to the two hops so an unrelated request (a favicon probe) cannot decide
    // the assertion. Chromium follows the redirect inside its own network stack: the
    // interceptor is offered the first hop only, and the second arrives here instead,
    // carrying the request it redirects from. This is the platform fact the provider's
    // request observer exists for; if a Playwright release starts routing redirect hops,
    // `routed` gains the second hop and this turns red.
    const hops = (urls: readonly string[]): string[] => urls.filter(url => url === start || url === internal)
    expect(hops(routed)).toEqual([start])
    expect(reported.filter(request => hops([request.url]).length === 1)).toEqual([
      { url: start, from: null },
      { url: internal, from: start },
    ])
    expect(navigation?.status()).toBe(200)
    expect(page.url()).toBe(internal)

    await context.close()
    await fixture.close()
  })

  it('fails the whole fetch when a rendered page is redirected to a private address', async () => {
    const fixture = await redirectFixture(port => `http://127.0.0.1:${String(port)}/internal`)
    // Chromium resolves the fixture hostname to loopback so a real navigation reaches
    // the server, and the policy's own resolver answers the same name as public — the
    // one address decision a loopback fixture cannot make honestly. The redirect target
    // is an IP literal, which the policy decides from the literal with no resolver at all.
    const { chromium } = await import('playwright')
    const mapped = await chromium.launch({
      headless: true,
      args: [`--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1`],
    })
    vi.spyOn(publicHttpNetwork, 'resolve').mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const access: BrowserAccess = {
      launch: async (): Promise<RenderBrowser> => mapped,
      probe: async () => undefined,
    }
    const provider = new PlaywrightFetchProvider({ ...limits, timeoutMs: 20_000 }, access)
    const { fetch: renderOne } = provider

    await expect(renderOne({ url: `http://${FIXTURE_HOST}:${String(fixture.port)}/start` }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_BLOCKED_URL',
        message: 'URL hostname "127.0.0.1" is a non-public IP address',
      }))

    await provider.dispose()
    await fixture.close()
  })
})

describe.skipIf(!installed)('Playwright WebSocket routing', () => {
  it('refuses a page WebSocket to a non-public address before it reaches the network', async () => {
    const browser = shared
    if (browser === undefined) throw new Error('the shared browser was never launched')
    const context = await browser.newContext({ userAgent: 'test-agent/1.0', serviceWorkers: 'block' })
    const policy = new DestinationPolicy(new AbortController().signal)
    // The real routing API, the real handler: an unrouted WebSocket would connect to
    // its server, so this is what keeps a rendered page off loopback and link-local.
    await context.routeWebSocket(interceptEverySocket, guardSocket(policy))
    const page = await context.newPage()
    await page.setContent('<html><body>socket</body></html>')

    const closure = await page.evaluate(async () => await new Promise<{ code: number; reason: string }>((resolve) => {
      const socket = new WebSocket('ws://127.0.0.1:9/')
      socket.onclose = (event) => { resolve({ code: event.code, reason: event.reason }) }
    }))

    // 1008 is this policy's refusal. An unrouted connection reports 1006 instead, from
    // the network refusing it, which is what an unguarded context produces.
    expect(closure).toEqual({ code: 1008, reason: 'refused by the web fetch destination policy' })
    await context.close()
  })

  it('does not route a WebSocket a dedicated worker opens', async () => {
    const browser = shared
    if (browser === undefined) throw new Error('the shared browser was never launched')
    const context = await browser.newContext({ userAgent: 'test-agent/1.0', serviceWorkers: 'block' })
    const routed: string[] = []
    await context.routeWebSocket(interceptEverySocket, async (socket) => {
      routed.push(socket.url())
      await socket.close({ code: 1008, reason: 'refused' })
    })
    const page = await context.newPage()
    await page.setContent('<html><body>worker</body></html>')

    const closure = await page.evaluate(async () => {
      const source = `self.onmessage = () => {
        const socket = new WebSocket('ws://127.0.0.1:9/')
        socket.onclose = event => { self.postMessage(event.code) }
      }`
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
      return await new Promise<number>((resolve) => {
        worker.onmessage = (event: MessageEvent<number>) => { resolve(event.data) }
        worker.postMessage('open')
        setTimeout(() => { resolve(-1) }, 5_000)
      })
    })

    // This pins the gap the README records: Playwright routes the connections a page or
    // frame opens, and a dedicated worker's socket reaches the network unrouted (1006,
    // the refusal from 127.0.0.1:9 itself). A Playwright release that closes this turns
    // the assertion red, which is when the limitation comes out of the README.
    expect(routed).toEqual([])
    expect(closure).toBe(1006)
    await context.close()
  })
})
