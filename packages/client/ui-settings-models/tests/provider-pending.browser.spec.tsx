import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import type { ModelsWire } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

function unexpectedRemote(): never {
  throw new Error('credential-only submission invoked a different Remote operation')
}

it.each(['success', 'transport failure'])('keeps a real browser credential write pending until %s', async (outcome) => {
  const pending = Promise.withResolvers<Awaited<ReturnType<ModelsWire['credentials']['set']>>>()
  const set = vi.fn<ModelsWire['credentials']['set']>(() => pending.promise)
  const onClose = vi.fn()
  const api: ModelsWire = {
    settings: { describe: unexpectedRemote, update: unexpectedRemote, replace: unexpectedRemote, mutate: unexpectedRemote },
    credentials: {
      describe: () => Promise.resolve({ ok: true, value: { DEEPSEEK_API_KEY: { configured: false, writable: true } } }),
      set,
      unset: unexpectedRemote,
    },
    llm: { discoverModels: unexpectedRemote, listProviders: unexpectedRemote, listConfigurableProviders: unexpectedRemote },
  }
  const namespace: SettingsNamespaceView = {
    ns: 'llm-deepseek', schema: { type: 'object', dict: {} },
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, revision: 0, applies: 'live', secrets: [],
  }
  render(<ProviderEditor
    provider="deepseek-official" displayName="DeepSeek" namespace={namespace}
    schema={settingsSchema} settingsPath={[]} api={api} t={key => en[key]}
    readOnly={false} credentialOnly credentialRequired
    cancelLabelKey="onboardingLater" submitLabelKey="onboardingSave"
    submitBusyLabelKey="onboardingSaving" onClose={onClose}
  />)
  await page.getByLabelText(en.keyInput).fill('sk-browser')
  await page.getByRole('button', { name: en.onboardingSave, exact: true }).click()
  await expect.element(page.getByRole('button', { name: en.onboardingSaving, exact: true })).toBeDisabled()
  await expect.element(page.getByRole('button', { name: en.onboardingLater, exact: true })).toBeDisabled()
  await expect.element(page.getByLabelText(en.keyInput)).toBeDisabled()
  expect(set).toHaveBeenCalledExactlyOnceWith('DEEPSEEK_API_KEY', 'sk-browser')
  expect(onClose).not.toHaveBeenCalled()

  await act(async () => {
    if (outcome === 'success') pending.resolve({ ok: true, value: undefined })
    else pending.reject(new Error('credential connection lost'))
    await Promise.resolve()
  })
  if (outcome === 'success') {
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true)
  } else {
    await expect.element(page.getByText('credential connection lost', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: en.onboardingSave, exact: true })).toBeEnabled()
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).value).toBe('sk-browser')
    expect(onClose).not.toHaveBeenCalled()
  }
})
