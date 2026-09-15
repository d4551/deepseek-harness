import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import axe from 'axe-core'
import { clientAxeRunOptions } from '@deepseek-ai/dsh-client-a11y'
import { en } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

import { populateTestWorkspace } from './test-workspace-copy.ts'
declare global {
  interface Window {
    axe: typeof axe
  }
}

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
let root: string

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-grammar-recovery-')))
  await populateTestWorkspace(sourceRoot, root)
}, 90_000)

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

// A separate browser observes pageerror without changing Vitest's own error handling.
it('retains a failed module download and restores both readable cards through explicit keyboard reload', async () => {
  const entry = 'packages/client/ui-primitives/tests/fixtures/grammar-recovery/index.html'
  const server = await createServer({
    configFile: false,
    root,
    resolve: { tsconfigPaths: true },
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { entries: [entry] },
    appType: 'mpa',
  })
  onTestFinished(async () => { await server.close() })
  await server.listen()
  const address = server.httpServer?.address()
  if (typeof address !== 'object' || address === null) throw new Error('Grammar verification server has no TCP address')
  await using browser = await chromium.launch()
  const page = await browser.newPage()
  const errors: string[] = []
  const consoleErrors: string[] = []
  const requests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.includes('/python') || url.includes('langs_python')) {
      requests.push(url)
      if (requests.length === 1) {
        await route.abort('connectionfailed')
        return
      }
    }
    await route.continue()
  })
  await page.goto(`http://127.0.0.1:${address.port}/${entry}`)
  const reload = page.getByRole('button', { name: en['code.reloadPage'] })
  await reload.first().waitFor()
  expect(await reload.count()).toBe(2)
  expect(await page.getByRole('status').allTextContents()).toEqual([
    `${en['code.highlightFailed']} ${en['code.reloadPage']}`,
    `${en['code.highlightFailed']} ${en['code.reloadPage']}`,
  ])
  expect(await page.locator('pre').textContent()).toBe('print(1)')
  expect(await page.locator('[data-read] [class*=content]').textContent()).toBe('print(1)')
  expect(await page.locator('pre.shiki').count()).toBe(0)
  expect(errors).toEqual(['Could not load syntax grammar "python"'])

  await page.getByRole('button', { name: 'Request updated code' }).click()
  await page.waitForFunction(() => document.querySelector('pre')?.textContent === 'print(2)')
  expect(await page.locator('pre.shiki').count()).toBe(0)
  expect(requests).toHaveLength(1)
  expect(errors).toHaveLength(1)

  await page.addScriptTag({ content: axe.source })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value === 'dark'), theme)
    const audit = await page.evaluate(async options => window.axe.run(document, options), clientAxeRunOptions())
    expect(audit.violations).toEqual([])
    expect(audit.incomplete).toEqual([])
    expect(audit.passes.length).toBeGreaterThan(0)
  }
  await reload.first().focus()
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(en['code.reloadPage'])
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('pre.shiki')?.textContent === 'print(1)')
  expect(await reload.count()).toBe(0)
  expect(await page.getByRole('status').count()).toBe(0)
  expect(await page.locator('[data-read] [class*=content] span').count()).toBeGreaterThan(1)
  expect(requests).toHaveLength(2)
  expect(errors).toEqual(['Could not load syntax grammar "python"'])
  expect(consoleErrors).toEqual(['Failed to load resource: net::ERR_CONNECTION_FAILED'])
})
