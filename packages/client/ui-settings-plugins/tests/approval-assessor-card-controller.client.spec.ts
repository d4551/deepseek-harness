import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ApprovalAssessorCardController, type ApprovalAssessorSettings,
} from '../src/client/approval-assessor-card-controller.ts'
import { acceptWrites } from './scope-stubs.client.ts'

describe('ApprovalAssessorCardController', () => {
  it('projects the complete Host policy', () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true, extraPhrases: ['first', 'second'] },
      base: { enabled: true, extraPhrases: [] },
      user: { extraPhrases: ['first', 'second'] },
    })

    expect(controller.inject().hooks.approvalAssessorCard.getSnapshot()).toMatchObject({
      enabled: { text: 'true', overridden: false },
      extraPhrases: { text: 'first\nsecond', overridden: true },
    })
  })

  it('saves enforcement and trimmed phrase lines together', async () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    acceptWrites(host)
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('enabled', 'false')
    face.edit('extraPhrases', ' first \n\n second ')
    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledTimes(2) })

    expect(host.set.mock.calls).toEqual([
      ['enabled', false],
      ['extraPhrases', ['first', 'second']],
    ])
    expect(face.hooks.approvalAssessorCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
  })

  it('stages clearing a user-owned phrase list', async () => {
    const host = stubSettingsScope<ApprovalAssessorSettings>()
    acceptWrites(host)
    const controller = new ApprovalAssessorCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { enabled: true, extraPhrases: ['custom'] },
      base: { enabled: true, extraPhrases: [] },
      user: { extraPhrases: ['custom'] },
    })
    const face = controller.inject()

    face.resetField('extraPhrases')
    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledWith('extraPhrases') })

    expect(host.set).not.toHaveBeenCalled()
  })
})
