// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, DshWindow,
  WebBootEntry,
} from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry } from '../src/boot.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const win = globalThis as DshWindow
const transportGlobal = globalThis as {
  __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
}
const bootReadyGlobal = globalThis as {
  __DSH_BOOT_READY__?: { promise: Promise<void> }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  delete transportGlobal.__DSH_TRANSPORT__
  delete bootReadyGlobal.__DSH_BOOT_READY__
  document.body.innerHTML = ''
})

function moduleExports(): Record<string, unknown> {
  return {
    createClientModuleSystem: modulesClient.createClientModuleSystem,
    apply: modulesClient.apply,
  }
}

function installFacade(
  create?: (options: ClientModuleCreateOptions) => modulesClient.ClientModuleSystem,
): ClientModuleLoaderTarget {
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: create ?? (options => modulesClient.createClientModuleSystem(target, {
      id: MODULES_ID,
      exports: moduleExports(),
    }, options)),
  }
  win.__ModuleLoader__ = target
  return target
}

function installGraph(entries: WebBootEntry[], batchUrl = '/application.js'): void {
  win.__DSH_BOOT__ = {
    rev: 'graph',
    entries,
    batches: [{
      phase: 'application',
      url: batchUrl,
      rev: 'batch',
      entries: entries.map(row => row.id),
    }],
  }
}

function rendererRegistration(): ClientBundleRegistration {
  return {
    id: 'renderer',
    factory: () => ({
      apply: (ctx: Context) => {
        ctx.reflect.provide('uiRenderer', {
          mount: (element: HTMLElement) => {
            element.textContent = 'mounted'
            return () => {}
          },
        })
      },
    }),
  }
}

function readinessDeferred(): { promise: Promise<undefined>; resolve: () => undefined; reject: (reason: Error) => undefined } {
  let resolveReady: (value: undefined) => void = () => undefined
  let rejectReady: (reason: Error) => void = () => undefined
  const promise = new Promise<undefined>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  return {
    promise,
    resolve: () => {
      resolveReady(undefined)
      return undefined
    },
    reject: (reason) => {
      rejectReady(reason)
      return undefined
    },
  }
}

async function runOn(container: HTMLElement, seams?: ClientModuleCreateOptions['loadBundle']): Promise<AppWebEntry> {
  const entry = seams === undefined
    ? new AppWebEntry(container)
    : new AppWebEntry(container, { loadBundle: seams })
  await entry.run()
  return entry
}

describe('immediate-tier prefetch reject', () => {
  it('swallows a prefetch refuse and retries the bundle through public run', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const applicationUrl = '/application.js'
    installGraph([
      { id: 'runtime', url: '/runtime.js', rev: '1', immediately: true },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ], applicationUrl)
    const loaded: string[] = []
    let arrivals = 0
    const entry = await runOn(container, async (url) => {
      loaded.push(url)
      arrivals += 1
      if (arrivals === 1) throw new Error('prefetch transport refused')
      if (url !== applicationUrl) throw new Error(`missing fixture batch ${url}`)
      target.load({ id: 'runtime', factory: () => ({ apply: () => {} }) })
      target.load(rendererRegistration())
    })
    expect(loaded).toEqual([applicationUrl, applicationUrl])
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })

  it('swallows a leftover non-Error prefetch refuse and still mounts through public run', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const applicationUrl = '/application.js'
    installGraph([
      { id: 'runtime', url: '/runtime.js', rev: '1', immediately: true },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ], applicationUrl)
    let arrivals = 0
    const entry = await runOn(container, async (url) => {
      arrivals += 1
      if (arrivals === 1) throw 'prefetch string refuse'
      if (url !== applicationUrl) throw new Error(`missing fixture batch ${url}`)
      target.load({ id: 'runtime', factory: () => ({ apply: () => {} }) })
      target.load(rendererRegistration())
    })
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })

  it('renders the loader import refuse after a swallowed prefetch refuse', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    installFacade()
    installGraph([{ id: 'runtime', url: '/runtime.js', rev: '1', immediately: true }])
    const entry = await runOn(container, async () => {
      throw new Error('bundle gone')
    })
    expect(container.textContent).toContain('failed to import')
    expect(container.textContent).toContain('bundle gone')
    expect(error).toHaveBeenCalledOnce()
    await entry.dispose()
  })
})

describe('activation audit through public run', () => {
  it('reports one leftover pending inject after loader.create and loader.await settle', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    installGraph([{ id: 'pending-row', url: '/pending.js', rev: '1' }])
    const entry = await runOn(container, async (url) => {
      if (url !== '/application.js') throw new Error(`missing fixture batch ${url}`)
      target.load({
        id: 'pending-row',
        factory: () => ({
          inject: ['absentService'],
          apply: () => {},
        }),
      })
    })
    expect(container.textContent).toContain('web boot: 1 entry did not activate')
    expect(container.textContent).toContain('pending-row: pending (waiting for service: absentService)')
    expect(error).toHaveBeenCalledOnce()
    await entry.dispose()
  })

  it('reports leftover pending injects for every missing service', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    installGraph([
      { id: 'first', url: '/first.js', rev: '1' },
      { id: 'second', url: '/second.js', rev: '1' },
    ])
    const entry = await runOn(container, async (url) => {
      if (url !== '/application.js') throw new Error(`missing fixture batch ${url}`)
      target.load({
        id: 'first',
        factory: () => ({
          inject: ['absentA', 'absentB'],
          apply: () => {},
        }),
      })
      target.load({
        id: 'second',
        factory: () => ({
          inject: ['absentC'],
          apply: () => {},
        }),
      })
    })
    expect(container.textContent).toContain('web boot: 2 entries did not activate')
    expect(container.textContent).toContain('first: pending (waiting for services: absentA, absentB)')
    expect(container.textContent).toContain('second: pending (waiting for service: absentC)')
    expect(error).toHaveBeenCalledOnce()
    await entry.dispose()
  })

  it('reports leftover pending inject as unknown when the service is present but refuses dependents', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    installGraph([
      { id: 'gate', url: '/gate.js', rev: '1' },
      { id: 'waiter', url: '/waiter.js', rev: '1' },
    ])
    const entry = await runOn(container, async (url) => {
      if (url !== '/application.js') throw new Error(`missing fixture batch ${url}`)
      target.load({
        id: 'gate',
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('blocked', { tag: 'blocked' }, () => false)
          },
        }),
      })
      target.load({
        id: 'waiter',
        factory: () => ({
          inject: ['blocked'],
          apply: () => {},
        }),
      })
    })
    expect(container.textContent).toContain('waiter: pending (waiting for services: unknown)')
    expect(error).toHaveBeenCalledOnce()
    await entry.dispose()
  })

  it('renders a leftover non-Error refuse from the facade through public run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    installFacade(() => {
      throw 'facade string refuse'
    })
    const entry = await runOn(container)
    expect(container.textContent).toContain('facade string refuse')
    expect(error).toHaveBeenCalledOnce()
    await entry.dispose()
  })
})

describe('boot-readiness deferred through public run', () => {
  it('waits for an installed readiness promise before creating the module system', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    installGraph([{ id: 'renderer', url: '/renderer.js', rev: '1' }])
    const ready = readinessDeferred()
    bootReadyGlobal.__DSH_BOOT_READY__ = ready
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        if (url !== '/application.js') throw new Error(`missing fixture batch ${url}`)
        target.load(rendererRegistration())
      },
    })
    const running = entry.run()
    ready.resolve()
    await running
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })

  it('renders a leftover readiness refuse', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const ready = readinessDeferred()
    bootReadyGlobal.__DSH_BOOT_READY__ = ready
    ready.reject(new Error('bootstrap refused'))
    const entry = await runOn(container)
    expect(container.textContent).toContain('bootstrap refused')
    expect(error).toHaveBeenCalledOnce()
    await entry.dispose()
  })
})

describe('public dispose and transport seams', () => {
  it('disposes the boot page when run never created a context', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const entry = new AppWebEntry(container)
    expect(container.childNodes.length).toBeGreaterThan(0)
    await entry.dispose()
    expect(container.childNodes).toHaveLength(0)
  })

  it('ignores a transport global that has no loadBundle and uses seams', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    installGraph([{ id: 'renderer', url: '/renderer.js', rev: '1' }])
    transportGlobal.__DSH_TRANSPORT__ = {}
    const entry = await runOn(container, async (url) => {
      if (url !== '/application.js') throw new Error(`missing fixture batch ${url}`)
      target.load(rendererRegistration())
    })
    expect(container.textContent).toBe('mounted')
    await entry.dispose()
  })
})
