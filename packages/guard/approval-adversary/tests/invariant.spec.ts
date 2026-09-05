/**
 * The verdict-accounting invariant: allowed notices this plugin commits never
 * outnumber granted approval decisions, and denied plus unavailable notices
 * never outnumber rejected ones.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as AdversaryInvariant from '../src/invariant.ts'
import { VERDICT_SUMMARIES, type AdversaryVerdict } from '../src/index.ts'

/** Mount the session store, the registry, and this package's companion. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AdversaryInvariant)
  return ctx
}

/** Append one notice attributed to this plugin. */
function appendNotice(session: Session, verdict: AdversaryVerdict): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Adversarial approval review: ${verdict}` }],
    source: { kind: 'plugin', plugin: 'approval-adversary', form: 'notice', summary: VERDICT_SUMMARIES[verdict] },
  }), { surfaceOp: 'append' })
}

/** Append one decided approval question. */
function decide(session: Session, id: string, outcome: ApprovalOutcome): void {
  const approvalId = ApprovalRequestId(id)
  session.append('approval/asked', { id: approvalId, toolName: 'bash' })
  session.append('approval/decided', { id: approvalId, outcome })
}

describe('approval-adversary invariant', () => {
  it('accepts an allowed notice that follows the grant it reports', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    decide(session, 'ask-granted', 'allowed-once')

    expect(() => { appendNotice(session, 'allowed') }).not.toThrow()
  })

  it('accepts denied and unavailable notices that follow their rejections', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    decide(session, 'ask-denied', 'rejected')
    decide(session, 'ask-undecided', 'rejected')

    expect(() => { appendNotice(session, 'denied') }).not.toThrow()
    expect(() => { appendNotice(session, 'unavailable') }).not.toThrow()
  })

  it('refuses an allowed notice with no grant behind it', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    decide(session, 'ask-rejected', 'rejected')

    expect(() => { appendNotice(session, 'allowed') })
      .toThrow(/allowed notice 1 has no granted approval decision behind it \(0 recorded\)/)
  })

  it('refuses a rejection notice with no rejection behind it', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    decide(session, 'ask-granted', 'allowed-once')

    expect(() => { appendNotice(session, 'denied') })
      .toThrow(/rejection notice 1 has no rejected approval decision behind it \(0 recorded\)/)
  })

  it('refuses a second notice for a single decision', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    decide(session, 'ask-once', 'allowed-once')
    appendNotice(session, 'allowed')

    expect(() => { appendNotice(session, 'allowed') })
      .toThrow(/allowed notice 2 has no granted approval decision behind it \(1 recorded\)/)
  })

  it('ignores cancelled and unavailable decisions and messages this plugin did not author', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    decide(session, 'ask-cancelled', 'cancelled')
    decide(session, 'ask-unavailable', 'unavailable')

    expect(() => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'do the work' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'another plugin' }],
        source: { kind: 'plugin', plugin: 'approval-assessor', form: 'notice', summary: 'mandatory-audit-rejected' },
      }), { surfaceOp: 'append' })
    }).not.toThrow()
    expect(() => { appendNotice(session, 'denied') })
      .toThrow(/rejection notice 1 has no rejected approval decision behind it \(0 recorded\)/)
  })
})
