// @vitest-environment jsdom

/** Axe floor for the workspace-root trigger, its panel, and its failure state. */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { WorkspaceRootsAction } from '../src/client/WorkspaceRootsAction.tsx'
import { zh } from '../src/client/locales.ts'
import { SECOND, projection, props, type RootsBench } from './roots-fixtures.client.ts'

const MINIMUM_ACCESSIBILITY_SCORE = 100

afterEach(cleanup)

/**
 * Open the panel and audit both the trigger and the panel.
 * @param bench - projection value and action overrides.
 * @param count - roots the trigger names, so its accessible name is addressable.
 */
async function assertPanelAccessible(bench: RootsBench, count: number): Promise<void> {
  render(<WorkspaceRootsAction {...props(bench).props} />)
  const trigger = screen.getByRole('button', { name: zh['trigger.aria'].replace('{count}', String(count)) })
  fireEvent.click(trigger)
  const audits = [
    await auditSurface('workspace roots trigger', trigger),
    await auditSurface('workspace roots panel', screen.getByRole('dialog')),
  ]
  expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
}

describe('WorkspaceRootsAction accessibility', () => {
  it('keeps the empty state accessible', async () => {
    await assertPanelAccessible({ roots: projection() }, 1)
    expect(screen.getByText(zh['empty.title'])).toBeTruthy()
  })

  it('keeps a populated root list accessible', async () => {
    await assertPanelAccessible({ roots: projection([SECOND]) }, 2)
    expect(screen.getByRole('list', { name: zh['list.aria'] })).toBeTruthy()
  })

  it('keeps the failure alert accessible', async () => {
    await assertPanelAccessible({ roots: projection() }, 1)
    fireEvent.change(screen.getByLabelText(zh['add.label']), { target: { value: 'relative' } })
    fireEvent.click(screen.getByRole('button', { name: zh['add.submit'] }))
    const audits = [await auditSurface('workspace roots alert', screen.getByRole('alert'))]
    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })

  it('keeps the loading placeholder accessible', async () => {
    render(<WorkspaceRootsAction {...props({ roots: undefined }).props} />)
    const audits = [await auditSurface(
      'workspace roots placeholder',
      screen.getByRole('status', { name: zh['trigger.loading'] }),
    )]
    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
