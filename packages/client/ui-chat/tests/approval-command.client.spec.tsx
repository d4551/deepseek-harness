// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, render, screen } from '@testing-library/react'
import { accessibilityScore, auditSurface, formatViolations } from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'
import { describe, expect, it } from 'vitest'
import { ApprovalCommand, commandOf } from '../src/client/chat/ApprovalCommand.tsx'
import { apply as nodeApply } from '../src/index.ts'
import * as ChatInvariant from '../src/invariant.ts'

function props(
  nodes: readonly unknown[],
  callId = 'call-1',
): PropsRuntime<'conversation.approval.detail'> {
  const snapshot = {
    nodes: { values: () => nodes },
  } as unknown as ChatSnapshot
  const useChat = ((selector: (value: ChatSnapshot) => unknown) => selector(snapshot)) as UseChat
  return { callId, useChat } as PropsRuntime<'conversation.approval.detail'>
}

describe('commandOf', () => {
  it('accepts only a string command from valid JSON arguments', () => {
    expect(commandOf(undefined)).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{}' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{"command":42}' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{"command":"bun run test"}' })).toBe('bun run test')
  })
})

describe('ApprovalCommand', () => {
  it('renders the running correlated Tool command', () => {
    render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: { callId: 'other', argsRaw: '{"command":"wrong"}' } } },
      { kind: 'tool-call', data: { root: { callId: 'call-1', argsRaw: '{"command":"bun run test"}' } } },
    ] as never)} />)

    expect(screen.getByText('bun run test')).toBeTruthy()
  })

  it('omits absent, uncorrelated, and settled Tool calls', () => {
    const { container, rerender } = render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: undefined } },
      { kind: 'tool-call', data: { root: { callId: 'other', argsRaw: '{}' } } },
      {
        kind: 'tool-call',
        data: { root: { kind: 'tool-result', callId: 'call-1', argsRaw: '{"command":"ignored"}' } },
      },
    ] as never)} />)
    expect(container.textContent).toBe('')

    rerender(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { callId: 'call-1', argsRaw: '{}' } } },
    ] as never)} />)
    expect(container.textContent).toBe('')
  })
})

describe('ui-chat package entries', () => {
  it('keeps the Host half optional and registers the invariant companion', async () => {
    const ctx = new Context()
    expect(() => { nodeApply(ctx) }).not.toThrow()
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(ChatInvariant).await()).resolves.toBeDefined()
  })
})

/**
 * An approval prompt is a decision the user has to make before work
 * continues, so the command it is asking about must be conveyed, not just
 * displayed. Audited against the same fixed WCAG A/AA rule set and floor the
 * primitives lane holds.
 */
describe('approval command accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for a correlated command', async () => {
    // This file renders without an afterEach cleanup, so earlier cases leave
    // their trees in the body. The audit reads the whole document, and their
    // landmark-less leftovers are not this surface's defect.
    cleanup()
    // The page shell supplies the `main` landmark the page-structure rules
    // need; without it the harness's own missing frame reads as a defect.
    const { baseElement } = render(<main><ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: { callId: 'call-1', argsRaw: '{"command":"bun run test"}' } } },
    ] as never)} /></main>)
    const audits: SurfaceAudit[] = [await auditSurface('ApprovalCommand', baseElement)]
    cleanup()

    // A surface that decided nothing would score 100 for free.
    for (const audit of audits) {
      expect(audit.passed + audit.failed, `${audit.surface} decided no checks`).toBeGreaterThan(0)
    }
    expect([...new Set(audits.flatMap(audit => audit.undecidedRules))]).toEqual(['color-contrast'])
    expect(audits.map(formatViolations).filter(text => text !== '').join('\n')).toBe('')
    expect(accessibilityScore(audits)).toBeGreaterThanOrEqual(MINIMUM_ACCESSIBILITY_SCORE)
  })
})
