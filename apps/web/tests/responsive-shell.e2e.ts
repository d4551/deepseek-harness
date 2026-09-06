// Web e2e scenario: the shell holds its layout contract at phone, tablet and
// desktop widths. Every other web scenario runs between 1100 and 1680px, so
// nothing measured what the shipped composition does on a small screen.
// Zero model calls: the scenario boots the Web composition and reads geometry.
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { launchBrowser, saveFailureShot } from './support.ts'

/** WCAG 2.5.8 Target Size (Minimum), the same floor the CSS SSOT scan holds. */
const HIT_TARGET_MIN_PX = 24

/** Rail width a collapsed sidebar keeps (`SIDEBAR_COLLAPSED`). */
const RAIL_PX = 56

/** Layout facts one rendered viewport reports. */
interface ShellFacts {
  innerWidth: number
  scrollWidth: number
  columns: number[]
  centerWidth: number
  drawerOpen: boolean
  scrims: number
  undersized: { label: string; width: number; height: number }[]
}

/**
 * Read the shell's geometry from a rendered page.
 * @param page - the page showing the booted composition.
 * @returns the facts the assertions below are made of.
 */
async function readShell(page: Page): Promise<ShellFacts> {
  return page.evaluate((minPx: number) => {
    const frame = document.querySelector('[class*="frame"]') as HTMLElement | null
    if (frame === null) throw new Error('shell frame is not mounted')
    const columns = getComputedStyle(frame).gridTemplateColumns
      .split(' ').map(part => Math.round(Number.parseFloat(part)))
    const center = frame.querySelector('[class*="centerCol"]') as HTMLElement | null
    const undersized: { label: string; width: number; height: number }[] = []
    const interactive = 'button, [role="button"], a[href], input, select, summary'
    for (const element of Array.from(document.querySelectorAll(interactive))) {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      const style = getComputedStyle(element)
      // A control nobody can reach is not a target: the workspace browser keeps
      // its search field mounted at zero opacity until the row expands.
      if (style.opacity === '0' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue
      if (box.width >= minPx && box.height >= minPx) continue
      undersized.push({
        label: `${element.tagName.toLowerCase()}.${(element as HTMLElement).className.slice(0, 48)}`,
        width: Math.round(box.width),
        height: Math.round(box.height),
      })
    }
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      columns,
      centerWidth: center === null ? 0 : Math.round(center.getBoundingClientRect().width),
      drawerOpen: frame.hasAttribute('data-sidebar-overlay'),
      scrims: document.querySelectorAll('[class*="scrim"]').length,
      undersized,
    }
  }, HIT_TARGET_MIN_PX)
}

describe('web e2e: shell layout across viewports', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await launchBrowser()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Boot the composition at one viewport.
   * @param width - viewport width in CSS pixels.
   * @param height - viewport height in CSS pixels.
   * @returns the page, left open for the caller to close.
   */
  async function boot(width: number, height: number): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    return page
  }

  it.each([
    { name: 'phone', width: 375, height: 812, railed: true },
    { name: 'tablet portrait', width: 768, height: 1024, railed: true },
    { name: 'tablet landscape', width: 1024, height: 768, railed: false },
    { name: 'desktop', width: 1440, height: 900, railed: false },
  ])('fits $name without overflow or an undersized control', async ({ name, width, height, railed }) => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-responsive-${width}`))
    const page = await boot(width, height)
    try {
      const shell = await readShell(page)

      // Nothing may push the document wider than the window: a shell that
      // scrolls sideways has already lost the small-screen case.
      expect(shell.scrollWidth, `${name} scrolls horizontally`).toBe(shell.innerWidth)
      expect(shell.undersized, `${name} has controls under ${HIT_TARGET_MIN_PX}px`).toEqual([])
      // Below the auto-collapse breakpoint the sidebar is the rail; at or above
      // it the sidebar owns a real column.
      expect(shell.columns[0], `${name} sidebar track`).toBe(railed ? RAIL_PX : 280)
      expect(shell.columns.reduce((total, column) => total + column, 0)).toBe(width)
    } finally {
      await page.close()
    }
  }, 120_000)

  it('opens the phone sidebar over the centre instead of squeezing it', async () => {
    // The sidebar never concedes width, so before the drawer a phone re-expand
    // left the centre at viewport minus the sidebar — 95px at 375, which clips
    // the composer and squeezes its trailing controls under the target floor.
    const page = await boot(375, 812)
    try {
      const collapsed = await readShell(page)
      expect(collapsed.drawerOpen).toBe(false)
      expect(collapsed.scrims).toBe(0)

      await page.getByRole('button', { name: 'Open sidebar' }).click()
      await page.waitForTimeout(600)
      const open = await readShell(page)

      expect(open.drawerOpen, 'the phone sidebar draws over the centre').toBe(true)
      expect(open.scrims, 'the drawer opens with a dismissal target').toBe(1)
      // The centre keeps the width it had: the drawer covers it, the grid does
      // not re-solve around it.
      expect(open.centerWidth).toBe(collapsed.centerWidth)
      expect(open.columns[0], 'the rail track stays behind the drawer').toBe(RAIL_PX)
      expect(open.undersized, 'a covered centre must not squeeze its controls').toEqual([])

      // The scrim spans the frame and the drawer covers its left 280px, so a
      // centre click lands on the drawer: press the part a reader can see.
      await page.locator('[class*="scrim"]').click({ position: { x: 330, y: 600 } })
      await page.waitForTimeout(600)
      const closed = await readShell(page)
      expect(closed.drawerOpen).toBe(false)
      expect(closed.scrims).toBe(0)
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps the column layout where the squeeze is still usable', async () => {
    // 768 is above the drawer breakpoint: expanding there takes a column and
    // leaves 488px of centre, which is why the drawer starts below it.
    const page = await boot(768, 1024)
    try {
      await page.getByRole('button', { name: 'Open sidebar' }).click()
      await page.waitForTimeout(600)
      const open = await readShell(page)

      expect(open.drawerOpen).toBe(false)
      expect(open.scrims).toBe(0)
      expect(open.columns[0]).toBe(280)
      expect(open.centerWidth).toBe(768 - 280)
      expect(open.undersized).toEqual([])
    } finally {
      await page.close()
    }
  }, 120_000)
})
