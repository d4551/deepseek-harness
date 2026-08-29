// @vitest-environment jsdom
import { createElement, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import { MessageFeedbackActions } from '../src/client/MessageFeedbackActions.tsx'
import type { MessageFeedbackActionProps } from '../src/client/slots.ts'
import type { MessageFeedbackView } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const MSG = 'm-1' as MessageId
const t = makeTranslate(zh, commonZh)

describe('message feedback accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for the rating pair', async () => {
    const view: MessageFeedbackView = {
      status: 'ready',
      items: new Map(),
      error: null,
    }
    const props: Pick<MessageFeedbackActionProps, 'messageId' | 'ensure' | 'rate' | 'toggle' | 'clearNote' | 'useFeedback' | 't'> = {
      messageId: MSG,
      ensure: vi.fn(() => Promise.resolve({ ok: true as const })),
      rate: vi.fn(() => Promise.resolve({ ok: true as const })),
      toggle: vi.fn(() => Promise.resolve({ ok: true as const })),
      clearNote: vi.fn(() => Promise.resolve({ ok: true as const })),
      useFeedback: <T,>(select: (v: MessageFeedbackView) => T): T =>
        useSyncExternalStore(() => () => {}, () => select(view)),
      t,
    }
    const { baseElement } = render(
      createElement('main', null, createElement(MessageFeedbackActions, props as MessageFeedbackActionProps)),
    )
    expect(accessibilityFailures(
      [await auditSurface('MessageFeedbackActions', baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })
})
