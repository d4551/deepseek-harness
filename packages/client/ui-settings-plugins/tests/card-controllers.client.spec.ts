/**
 * Several card controllers over one settings scope at once: a Host publish
 * must reach every card hook in the same notification, and each card must
 * project only the fields its own namespace owns.
 */

import { describe, expect, it } from 'vitest'
import { stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentLoopCardController } from '../src/client/agent-loop-card-controller.ts'
import { ApprovalAssessorCardController } from '../src/client/approval-assessor-card-controller.ts'
import { BashCardController } from '../src/client/bash-card-controller.ts'

/** One scope carrying every card's fields, as a merged Host document. */
type MergedSettings = {
  timeoutMs?: number
  maxOutputBytes?: number
  maxParallelToolCalls?: number
  enabled?: boolean
  extraPatterns?: string[]
}

describe('card controllers over one shared scope', () => {
  function mountedCards(host: StubSettingsScope<MergedSettings>) {
    const bash = new BashCardController(host.scope)
    const loop = new AgentLoopCardController(host.scope)
    const approval = new ApprovalAssessorCardController(host.scope)
    return {
      bash: bash.inject().hooks.bashCard,
      loop: loop.inject().hooks.agentLoopCard,
      approval: approval.inject().hooks.approvalAssessorCard,
    }
  }

  it('delivers one Host publish to every card hook', () => {
    const host = stubSettingsScope<MergedSettings>()
    const cards = mountedCards(host)

    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 5_000, maxParallelToolCalls: 10, enabled: true },
      base: { timeoutMs: 60_000 },
      user: { timeoutMs: 5_000 },
    })

    expect(cards.bash.getSnapshot().timeoutMs.text).toBe('5000')
    expect(cards.loop.getSnapshot().maxParallelToolCalls.text).toBe('10')
    expect(cards.approval.getSnapshot().enabled.text).toBe('true')
  })

  it('updates every card on a later publish, not only the first', () => {
    const host = stubSettingsScope<MergedSettings>()
    const cards = mountedCards(host)
    host.publish({ status: 'ready', writable: true, value: { timeoutMs: 5_000 } })
    expect(cards.bash.getSnapshot().timeoutMs.text).toBe('5000')

    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 9_000, maxParallelToolCalls: 2, extraPatterns: ['late'] },
      base: { timeoutMs: 60_000 },
      user: { timeoutMs: 9_000 },
    })

    expect(cards.bash.getSnapshot().timeoutMs).toMatchObject({ text: '9000', overridden: true })
    expect(cards.loop.getSnapshot().maxParallelToolCalls.text).toBe('2')
    expect(cards.approval.getSnapshot().extraPatterns.text).toBe('late')
  })

  it('projects only the fields each namespace owns from a merged document', () => {
    const host = stubSettingsScope<MergedSettings>()
    const cards = mountedCards(host)

    host.publish({
      status: 'ready',
      writable: true,
      value: {
        timeoutMs: 5_000, maxOutputBytes: 64_000,
        maxParallelToolCalls: 10,
        enabled: true, extraPatterns: ['x'],
      },
    })

    const bash = cards.bash.getSnapshot()
    expect(bash.timeoutMs.text).toBe('5000')
    // maxOutputBytes is absent from this document, so the Bash card shows
    // its built-in default rather than inheriting a sibling card's value.
    expect(bash.maxOutputBytes.text).toBe('64000')
    expect(cards.loop.getSnapshot().maxParallelToolCalls.text).toBe('10')
    expect(cards.approval.getSnapshot().enabled.text).toBe('true')
    expect(cards.approval.getSnapshot().extraPatterns.text).toBe('x')
  })
})
