import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PluginCard } from '../src/client/PluginCard.tsx'
import type { CardShell } from '../src/client/card-form.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it.each(['save', 'outside'])('preserves focus ownership after disabling Save: %s', async (destination) => {
  const onSave = vi.fn()
  const onDiscard = vi.fn()
  const state: CardShell = { available: true, writable: true, restartRequired: false,
    dirty: true, invalid: false, saving: false, failed: false }
  const card = (current: CardShell) => (
    <main>
      <button type="button">Other setting</button>
      <ul>
        <PluginCard titleKey="bashTitle" descriptionKey="bashDescription" state={current}
          t={makeTranslate(en)} onSave={onSave} onDiscard={onDiscard}>
          <p>Terminal preferences</p>
        </PluginCard>
      </ul>
    </main>
  )
  const view = render(card(state))
  await page.getByRole('button', { name: `${en.expand}: ${en.bashTitle}` }).click()
  await page.getByRole('button', { name: en.save, exact: true }).click()
  expect(onSave).toHaveBeenCalledOnce()
  act(() => { view.rerender(card({ ...state, saving: true })) })
  expect(document.activeElement).toBe(document.body)
  if (destination === 'outside') await page.getByRole('button', { name: 'Other setting' }).click()
  act(() => { view.rerender(card({ ...state, dirty: false })) })
  const expectedName = destination === 'outside' ? 'Other setting' : `${en.expand}: ${en.bashTitle}`
  expect(document.activeElement).toBe(screen.getByRole('button', { name: expectedName }))
})
