import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ApprovalAdversaryCardController, type ApprovalAdversarySettings,
} from '../src/client/approval-adversary-card-controller.ts'
import { acceptWrites } from './scope-stubs.client.ts'

describe('ApprovalAdversaryCardController', () => {
  it('projects the complete Host policy', () => {
    const host = stubSettingsScope<ApprovalAdversarySettings>()
    const controller = new ApprovalAdversaryCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: {
        enabled: true,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        fallback: 'reject',
        timeoutMs: 30_000,
        maxOutputTokens: 256,
        maxExcerptChars: 4000,
        instructions: 'Deny anything that touches production.',
      },
      base: { enabled: false, fallback: 'delegate', timeoutMs: 30_000, maxOutputTokens: 256, maxExcerptChars: 4000, instructions: '' },
      user: { enabled: true, provider: 'deepseek-official', model: 'deepseek-v4-flash', fallback: 'reject', instructions: 'Deny anything that touches production.' },
    })

    expect(controller.inject().hooks.approvalAdversaryCard.getSnapshot()).toMatchObject({
      enabled: { text: 'true', overridden: true },
      provider: { text: 'deepseek-official', overridden: true },
      model: { text: 'deepseek-v4-flash', overridden: true },
      fallback: { text: 'reject', overridden: true },
      timeoutMs: { text: '30000', overridden: false },
      maxOutputTokens: { text: '256', overridden: false },
      maxExcerptChars: { text: '4000', overridden: false },
      instructions: { text: 'Deny anything that touches production.', overridden: true },
    })
  })

  it('saves the reviewer switch, the route pair, the fallback, and the caps together', async () => {
    const host = stubSettingsScope<ApprovalAdversarySettings>()
    acceptWrites(host)
    const controller = new ApprovalAdversaryCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('enabled', 'true')
    face.edit('provider', ' deepseek-official ')
    face.edit('model', 'deepseek-v4-flash')
    face.edit('fallback', 'reject')
    face.edit('timeoutMs', '15000')
    face.edit('maxOutputTokens', '128')
    face.edit('maxExcerptChars', '2000')
    face.edit('instructions', ' Deny anything that touches production. ')
    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledTimes(8) })

    expect(host.set.mock.calls).toEqual([
      ['enabled', true],
      ['provider', 'deepseek-official'],
      ['model', 'deepseek-v4-flash'],
      ['fallback', 'reject'],
      ['timeoutMs', 15_000],
      ['maxOutputTokens', 128],
      ['maxExcerptChars', 2000],
      ['instructions', 'Deny anything that touches production.'],
    ])
    expect(face.hooks.approvalAdversaryCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
  })

  it('blocks the save while a cap is not a number', () => {
    const host = stubSettingsScope<ApprovalAdversarySettings>()
    const controller = new ApprovalAdversaryCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { timeoutMs: 30_000 }, base: { timeoutMs: 30_000 }, user: {} })
    const face = controller.inject()

    face.edit('timeoutMs', 'soon')

    expect(face.hooks.approvalAdversaryCard.getSnapshot()).toMatchObject({
      invalid: true,
      timeoutMs: { text: 'soon', invalid: true },
    })
  })

  it('stages clearing a user-owned route back to the agent route', async () => {
    const host = stubSettingsScope<ApprovalAdversarySettings>()
    acceptWrites(host)
    const controller = new ApprovalAdversaryCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      base: { enabled: false },
      user: { enabled: true, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const face = controller.inject()

    face.resetField('provider')
    face.resetField('model')
    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledTimes(2) })

    expect(host.unset.mock.calls).toEqual([['provider'], ['model']])
    expect(host.set).not.toHaveBeenCalled()
    expect(face.hooks.approvalAdversaryCard.getSnapshot()).toMatchObject({
      provider: { text: '', overridden: false },
      model: { text: '', overridden: false },
    })
  })
})
