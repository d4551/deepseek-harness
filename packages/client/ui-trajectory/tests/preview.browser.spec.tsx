import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { TrajectoryCell } from '../src/client/TrajectoryCell.tsx'
import { trajectoryPreviewText } from '../src/client/trajectory-preview.ts'
import { t } from './locale.client.ts'

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
})

it.each([
  { theme: 'light', width: 1280 },
  { theme: 'dark', width: 1280 },
  { theme: 'light', width: 640 },
  { theme: 'dark', width: 640 },
])('keeps footnote words separated in the $theme trajectory preview at $width px', async ({ theme, width }) => {
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
  await page.viewport(width, 720)
  const markdown = 'Read this[^note].\n\n[^note]: First paragraph.\n\n    Second paragraph.'
  const preview = trajectoryPreviewText(markdown)
  expect(preview).toBe('Read this. First paragraph. Second paragraph.')

  render(<main><TrajectoryCell
    t={t}
    index={1}
    kind="message"
    text={preview}
    timeSeconds={1}
  /></main>)

  expect(screen.getByText(preview).getBoundingClientRect().width).toBeGreaterThan(0)
  expect(getComputedStyle(screen.getByText(preview)).whiteSpace).toBe('nowrap')
  const audit = await auditSurface('Trajectory Markdown preview', document.body)
  expect(audit.passed).toBeGreaterThan(0)
  expect(audit.violations).toEqual([])
  expect(audit.incomplete).toEqual([])
})
