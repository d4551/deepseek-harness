/**
 * Shared host-side support for the settings web e2e scenarios: the shared-home
 * second scaffold launcher, the durable settings-document reader, golden paths,
 * and the suite boot. Host face (drives the real host + browser); node
 * built-ins are expected here and the `.client.` infix convention does not
 * apply.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { launchWebScaffold, watchConsole, type WebScaffold } from './tests/scaffold.ts'
import { ZH_BROWSER_LOCALE } from './tests/support.ts'

/** One running settings suite: the scaffold, its browser, and the shared page. */
export interface SettingsSuite {
  scaffold: WebScaffold
  browser: Browser
  page: Page
  tripwire: ReturnType<typeof watchConsole>
}

/**
 * Boot the settings suite: a real host scaffold, one Chromium instance, and
 * the shared Chinese-locale page navigated to the authenticated frame.
 * @returns the suite handles for the file's beforeAll.
 */
export async function launchSettingsSuite(): Promise<SettingsSuite> {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  return { scaffold, browser, page, tripwire: watchConsole(page) }
}

/** Absolute paths of the settings surface's committed goldens. */
export function settingsGoldens(): { dialog: string; plugins: string; dialogEn: string; snapshotDir: string } {
  const snapshotDir = fileURLToPath(new URL('./tests/expected/settings-chrome', import.meta.url))
  return {
    snapshotDir,
    dialog: join(snapshotDir, 'dialog.expected.md'),
    plugins: join(snapshotDir, 'plugins.expected.md'),
    dialogEn: join(snapshotDir, 'dialog-en.expected.md'),
  }
}

/**
 * Read the scaffold's durable user-settings document.
 * @param scaffold - the running web scaffold whose home owns settings.yaml.
 * @returns the raw YAML text.
 */
export function readSettingsDocument(scaffold: WebScaffold): Promise<string> {
  return readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
}

export interface SecondScaffoldPage {
  /** The freshly launched scaffold sharing the first scaffold's home. */
  readonly scaffold: WebScaffold
  /** The page navigated to the scaffold's authenticated URL, frame mounted. */
  readonly page: Page
  /** The console tripwire bound to the new page. */
  readonly tripwire: ReturnType<typeof watchConsole>
  /** Close the page and its scaffold as one unit. */
  readonly close: () => Promise<void>
}

/**
 * Launch a second live Host on another ephemeral port sharing `first`'s home,
 * with its own Chinese-locale browser page already on the authenticated frame.
 * @param browser - the shared Chromium instance.
 * @param first - the originating scaffold whose harness home is shared.
 */
export async function launchSharedHomeScaffold(browser: Browser, first: WebScaffold): Promise<SecondScaffoldPage> {
  const scaffold = await launchWebScaffold({ harnessHome: first.harnessHome })
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  return {
    scaffold,
    page,
    tripwire,
    close: async () => {
      await page.close()
      await scaffold.close()
    },
  }
}
