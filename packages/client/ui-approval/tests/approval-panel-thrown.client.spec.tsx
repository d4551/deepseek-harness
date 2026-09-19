// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ApprovalPanel } from '../src/client/ApprovalPanel.tsx'
import type { ApprovalComposerProps } from '../src/client/contract/slots.ts'
import { PendingApproval } from '../src/client/contract/slots.ts'

afterEach(cleanup)

function panelProps(pending: PendingApproval): ApprovalComposerProps {
  const messages: Record<string, string> = {
    waiting: 'Waiting',
    'detail.aria': 'Approval details',
    escalation: `Tool ${pending.toolName} asks`,
    reject: 'Reject',
    allowOnce: 'Allow once',
  }
  return {
    matched: pending,
    renderSlot: vi.fn<ApprovalComposerProps['renderSlot']>(() => null),
    t: (key: string) => messages[key] ?? key,
  } as ApprovalComposerProps
}

describe('ApprovalPanel Thrown claim', () => {
  it('re-enables actions and shows a non-Error answer refusal', async () => {
    const pending = new PendingApproval(SessionId('s1'), { toolName: 'bash' })
    vi.spyOn(pending, 'answer').mockRejectedValue('plain refusal')
    render(<ApprovalPanel {...panelProps(pending)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('plain refusal')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(false)
    const settled = pending.result
    pending.abort(new Error('test cleanup'))
    await expect(settled).rejects.toThrow('test cleanup')
  })
})
