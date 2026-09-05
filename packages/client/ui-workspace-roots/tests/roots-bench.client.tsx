// @vitest-environment jsdom

/** Render bench shared by the workspace-root panel specs: the open panel over one fixture bench. */

import { fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceRootsAction } from '../src/client/WorkspaceRootsAction.tsx'
import { zh } from '../src/client/locales.ts'
import { props, type RootsBench } from './roots-fixtures.client.ts'

/** The trigger's accessible name for a root set of `count` folders. */
export function panelTriggerName(count: number): string {
  return zh['trigger.aria'].replace('{count}', String(count))
}

/** The add-folder field. */
export function panelField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(zh['add.label'])
}

/**
 * Render the panel open over one bench.
 * @param bench - projection value and action overrides.
 * @returns the built props plus the recorded-call ledger.
 */
export function openPanel(bench: RootsBench = {}): ReturnType<typeof props> {
  const built = props(bench)
  const roots = bench.roots
  const count = roots === undefined
    ? 0
    : roots.additional.length + (roots.primary === null ? 0 : 1)
  render(<WorkspaceRootsAction {...built.props} />)
  fireEvent.click(screen.getByRole('button', { name: panelTriggerName(count) }))
  return built
}
