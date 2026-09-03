/**
 * The redirect-accounting invariant: redirects this plugin commits to a
 * session never outnumber that session's rejected approval decisions.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import * as AssessorInvariant from '../src/invariant.ts'

/** Mount the session store, the registry, and this package's companion. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(AssessorInvariant)
  return ctx
}

/** Append one redirect attributed to this plugin. */
function appendRedirect(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Approval denied: …' }],
    source: { kind: 'plugin', plugin: 'approval-assessor', form: 'notice', summary: 'evasion-rejected' },
  }), { surfaceOp: 'append' })
}

describe('approval-assessor invariant', () => {
  it('accepts a redirect that follows the rejection it explains', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('ask-rejected')
    session.append('approval/asked', { id, toolName: 'read' })
    session.append('approval/decided', { id, outcome: 'rejected' })

    expect(() => { appendRedirect(session) }).not.toThrow()
  })

  it('refuses a redirect with no rejection behind it', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('ask-open')
    session.append('approval/asked', { id, toolName: 'read' })

    expect(() => { appendRedirect(session) })
      .toThrow(/redirect 1 has no rejected approval decision behind it \(0 recorded\)/)
  })

  it('refuses a second redirect for a single rejection', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('ask-once')
    session.append('approval/asked', { id, toolName: 'read' })
    session.append('approval/decided', { id, outcome: 'rejected' })
    appendRedirect(session)

    expect(() => { appendRedirect(session) })
      .toThrow(/redirect 2 has no rejected approval decision behind it \(1 recorded\)/)
  })

  it('counts only rejected decisions, not grants', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const id = ApprovalRequestId('ask-allowed')
    session.append('approval/asked', { id, toolName: 'read' })
    session.append('approval/decided', { id, outcome: 'allowed-once' })

    expect(() => { appendRedirect(session) })
      .toThrow(/redirect 1 has no rejected approval decision behind it \(0 recorded\)/)
  })

  it('ignores messages this plugin did not author', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })

    expect(() => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'do the work' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }).not.toThrow()
  })
})
