// Web e2e scenario: the plan-review takeover. The shipped composition mounts
// plan mode and its client seat, so `/plan <task>` enters plan mode for real
// and the recorded turn ends on exit_plan_mode blocking against the live
// userInteraction seam. The composer is then occupied by the plan decision
// card — not the generic question flow — and approving it through the card
// completes the turn with the approval in the log.
// Replay is deterministic: the plan content arrives from replayed chunks, the
// review wait is real, and the approve click is the test's own gesture (the
// turn cannot complete without it, in record and replay alike).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, launchBrowser, newEnglishPage, saveFailureShot } from './support.ts'
import { assertPageAccessibility } from './accessibility.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/plan-review', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
// The waiting golden owns the decision card; the approved golden owns the
// transcript the approval leaves behind — the state the card cannot see.
const REVIEW_EXPECTED = join(SNAPSHOT_DIR, 'review.expected.md')
const SIDEBAR_EXPECTED = join(SNAPSHOT_DIR, 'sidebar.expected.md')
const APPROVED_EXPECTED = join(SNAPSHOT_DIR, 'approved.expected.md')
const APPROVED_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'approved-expanded.expected.md')
const MODE = webSnapshotMode()
const COLOR_SCHEMES: Array<'light' | 'dark'> = ['light', 'dark']

// One command line: /plan enters plan mode and submits the rest as the turn's
// message. The task is deliberately self-contained (nothing to explore in a
// fresh workspace) so the recorded turn is a plan and its review, and the
// approved continuation is one word.
const TASK = 'Plan a small change: add a --greeting flag to a CLI. Do not read or write any files. '
  + 'Call exit_plan_mode with a short plan of at most five bullet points. '
  + 'Once the plan is approved, reply with the single word DONE and stop.'
const LINE = `/plan ${TASK}`

describe.each(COLOR_SCHEMES)('web e2e: plan review takeover round trip (%s)', (colorScheme) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15, compareReplaySession: true })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await launchBrowser()
    // English page: the decision copy is the surface under test, and the
    // golden pins one language.
    page = await newEnglishPage(browser)
    await page.emulateMedia({ colorScheme })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(await page.locator('body').getAttribute('data-ds-dark-theme')).toBe(colorScheme === 'dark' ? '' : null)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('reviews the plan on a decision card and approves through it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plan-review'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([TASK])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 180_000 : 30_000)
    await input.fill(LINE)
    await input.press('Enter')

    // The card takes over the input area while exit_plan_mode blocks. Its
    // presence is a STABLE waiting state (it stays until answered), so a plain
    // waitFor is race-free.
    const card = page.locator('[data-plan-review-key]')
    await card.waitFor({ timeout: MODE === 'record' ? 120_000 : 30_000 })
    // The plan-review request must NOT land on the generic question flow.
    expect(await page.locator('[data-question-key]').count()).toBe(0)
    await expect.poll(() => card.getByText('Plan review').count(), { timeout: 10_000 }).toBeGreaterThan(0)

    const currentRow = page.locator('[role="treeitem"][aria-current="true"]')
    await expect.poll(() => currentRow.locator('[data-state="warning"]').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => currentRow.getByText('Plan awaiting review', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await assertPageAccessibility(page)

    if (MODE !== 'record') {
      const snapshot = await captureStableAria(page, '[data-plan-review-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(REVIEW_EXPECTED, snapshot, MODE)
      const sidebar = await captureStableAria(page, '[role="treeitem"][aria-current="true"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(SIDEBAR_EXPECTED, sidebar, MODE)
    }

    await card.getByRole('button', { name: 'Approve' }).click()

    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    // World state: the approval reached the tool, and plan mode is left behind.
    const results = sessionEvents.filter(e => e.type === 'tool/result')
    expect(JSON.stringify(results.at(-1))).toContain('Plan approved')
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    // Card gone; regular input restored.
    expect(await page.locator('[data-plan-review-key]').count()).toBe(0)
    expect(await currentRow.locator('[data-state="warning"]').count()).toBe(0)
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    await assertPageAccessibility(page)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(APPROVED_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(APPROVED_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.jsonl', 'review.expected.md', 'sidebar.expected.md',
      'approved.expected.md', 'approved-expanded.expected.md',
    ])
  })
})
