/**
 * The approval assessor's controller: the screening switch, the extra
 * patterns list, and how drafts of each settle into one save pass.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ApprovalAssessorCardController,
  type ApprovalAssessorSettings,
} from '../src/client/approval-assessor-card-controller.ts'
import { acceptWrites } from './scope-stubs.client.ts'

describe('ApprovalAssessorCardController', () => {
  it('renders an unset namespace empty and rejects non-boolean screening drafts', () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { extraPatterns: ['skip it'] },
      base: { extraPatterns: ['skip it'] },
      user: {},
    })
    const face = controller.inject()

    // `enabled` carries no value anywhere, so its control renders blank.
    expect(face.hooks.approvalAssessorCard.getSnapshot().enabled.text).toBe('')
    expect(face.hooks.approvalAssessorCard.getSnapshot().extraPatterns.text).toBe('skip it')

    face.edit('enabled', 'maybe')
    const blocked = face.hooks.approvalAssessorCard.getSnapshot()
    expect(blocked.enabled.invalid).toBe(true)
    expect(blocked.invalid).toBe(true)
  })

  it('saves an affirmative screening draft as true', async () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    acceptWrites(host)
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('enabled', ' True ')
    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledOnce() })

    expect(host.set).toHaveBeenCalledWith('enabled', true)
  })

  it('clears the screening switch when its control is emptied', async () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    acceptWrites(host)
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true },
      base: { enabled: true },
      user: { enabled: true },
    })
    const face = controller.inject()

    face.edit('enabled', '  ')
    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledWith('enabled') })
  })

  it('saves the screening switch and the extra patterns together', async () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    acceptWrites(host)
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('enabled', 'FALSE')
    face.edit('extraPatterns', '  leave it as-is \n\nknown issue\n')
    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledTimes(2) })

    expect(host.set.mock.calls).toEqual([
      ['enabled', false],
      ['extraPatterns', ['leave it as-is', 'known issue']],
    ])
    expect(face.hooks.approvalAssessorCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
  })

  it('stages a clear so saving lets both fields re-inherit the composition layer', async () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    acceptWrites(host)
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: false, extraPatterns: ['pre-existing'] },
      base: { enabled: false, extraPatterns: ['pre-existing'] },
      user: { enabled: false, extraPatterns: ['pre-existing'] },
    })
    const face = controller.inject()

    face.resetField('enabled')
    face.resetField('extraPatterns')
    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledTimes(2) })

    expect(host.unset.mock.calls).toEqual([['enabled'], ['extraPatterns']])
    expect(face.hooks.approvalAssessorCard.getSnapshot().dirty).toBe(false)
  })

  it('clears the patterns when every staged line is blank', async () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    acceptWrites(host)
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { extraPatterns: ['old'] },
      base: { extraPatterns: ['old'] },
      user: { extraPatterns: ['old'] },
    })
    const face = controller.inject()

    face.edit('extraPatterns', '\n  \n')
    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledWith('extraPatterns') })
  })

  it('drops non-string entries when formatting what the Host serves', () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { extraPatterns: ['kept', 7, null] } as never,
      base: {},
      user: {},
    })

    expect(controller.inject().hooks.approvalAssessorCard.getSnapshot().extraPatterns.text).toBe('kept')
  })

  it('reports a read-only document so the card can disable its controls', () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    const controller = new ApprovalAssessorCardController(host.scope)

    host.publish({ status: 'ready', writable: false, value: { enabled: true } })

    expect(controller.inject().hooks.approvalAssessorCard.getSnapshot().writable).toBe(false)
  })
})
