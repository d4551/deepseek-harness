import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { launchBrowser, newEnglishPage } from './support.ts'
import { assertPageAccessibility } from './accessibility.ts'

const themes: Array<'light' | 'dark'> = ['light', 'dark']
const sections = ['General', 'Models', 'Plugins', 'Agent presets']
const viewports = [{ width: 1680, height: 1000 }, { width: 390, height: 844 }]
const cases = themes.flatMap(theme => sections.flatMap(section =>
  viewports.map(viewport => ({ theme, section, viewport }))))

it.each(cases)('renders $section in $theme at $viewport.width without clipping or inline styles', async ({ theme, section, viewport }) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await launchBrowser()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => { errors.push(error.message) })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('navigation').getByRole('button', { name: section, exact: true }).click()
  if (section === 'Agent presets') await dialog.getByRole('button', { name: 'View: Standard mode', exact: true }).waitFor()
  await page.setViewportSize(viewport)
  expect(await dialog.getByRole('button', { name: section, exact: true }).getAttribute('aria-current')).toBe('true')
  expect(await dialog.getByRole('heading', { name: 'Settings', exact: true }).isVisible()).toBe(true)
  expect(await dialog.getByRole('button', { name: 'Close', exact: true }).isVisible()).toBe(true)
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  if (bounds === null) throw new Error('Settings dialog has no rendered bounds')
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
  await page.screenshot({ path: `.artifacts/finish/verified-${section.replaceAll(' ', '-')}-${theme}-${viewport.width}-top.png` })
  await dialog.press('Tab')
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await dialog.press('Shift+Tab')
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  expect(await dialog.getByRole('navigation').getByRole('button', { name: 'General', exact: true }).isVisible()).toBe(true)
  await page.screenshot({ path: `.artifacts/finish/verified-${section.replaceAll(' ', '-')}-${theme}-${viewport.width}.png` })
  expect(await dialog.locator('[style]').evaluateAll(elements => elements.every(element => element.getAttribute('style') === ''))).toBe(true)
  expect(errors).toEqual([])
  await assertPageAccessibility(page)
})
