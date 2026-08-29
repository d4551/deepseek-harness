// @vitest-environment jsdom
/**
 * axe-core audit of the ui-message-feedback browser surface: the rating
 * controls over a ready view with a recorded rating (the pressed state) and
 * over an empty view (both buttons unpressed).
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { MessageId } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  MessageFeedbackItem, MessageFeedbackRating, MessageFeedbackVersion,
} from '@deepseek-ai/dsh-message-feedback/types'
import { MessageFeedbackActions } from '../src/client/MessageFeedbackActions.tsx'
import type { MessageFeedbackActionProps } from '../src/client/slots.ts'
import type { MessageFeedbackActionResult, MessageFeedbackView } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const MSG = 'm-1' as MessageId
const SESSION = 's-a11y' as SessionId
const t: MessageFeedbackActionProps['t'] = makeTranslate(zh, commonZh)

/** Render the controls over one fixed view; the framework seats are idle stubs. */
function mountFeedback(current: MessageFeedbackItem | undefined) {
  const view: MessageFeedbackView = {
    status: 'ready',
    items: new Map(current === undefined ? [] : [[MSG, current]]),
    error: null,
  }
  const ok = (): Promise<MessageFeedbackActionResult> => Promise.resolve({ ok: true })
  const props: MessageFeedbackActionProps = {
    messageId: MSG,
    sessionId: SESSION,
    useSession: vi.fn(),
    useProjection: vi.fn(),
    useSessions: vi.fn(),
    useSessionPendingInteraction: vi.fn(),
    useConversation: vi.fn(),
    useInput: vi.fn(),
    inputActions: {
      setDraft: () => {},
      addImages: () => false,
      removeImage: () => {},
      pruneImages: () => {},
      submit: () => {},
    },
    useChat: vi.fn(),
    useTrajectory: vi.fn(),
    useWorkspaces: vi.fn(),
    ensure: () => ok(),
    rate: (_id: MessageId, _rating: MessageFeedbackRating, _note?: string) => ok(),
    toggle: (_id: MessageId, _rating: MessageFeedbackRating) => ok(),
    clearNote: (_id: MessageId) => ok(),
    clear: (_id: MessageId) => ok(),
    useFeedback: <T,>(select: (v: MessageFeedbackView) => T): T => select(view),
    t,
  }
  return render(<main><MessageFeedbackActions {...props} /></main>)
}

describe('ui-message-feedback accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100
  const item = (rating: MessageFeedbackItem['rating']): MessageFeedbackItem => ({
    messageId: MSG,
    rating,
    version: 'v1' as MessageFeedbackVersion,
    createdAt: 1,
    updatedAt: 1,
  })

  it('renders no accessibility violations for the rating controls', async () => {
    const audits: SurfaceAudit[] = []
    const unpressed = mountFeedback(undefined)
    audits.push(await auditSurface('MessageFeedbackActions(unpressed)', unpressed.baseElement))
    cleanup()
    const pressed = mountFeedback(item('positive'))
    audits.push(await auditSurface('MessageFeedbackActions(pressed)', pressed.baseElement))
    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
