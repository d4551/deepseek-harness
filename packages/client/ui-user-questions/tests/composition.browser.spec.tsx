import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { PendingQuestion, type QuestionComposerProps } from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const dictionary = { ...commonEn, ...en }
const t: QuestionComposerProps['t'] = key => dictionary[key]

it.each([false, true])('keeps composition confirmation separate from submission with options=%s', async (withOptions) => {
  await page.viewport(1280, 720)
  const sessionId = SessionId('composition-browser')
  const pending = new PendingQuestion(sessionId, [{
    id: 'answer',
    question: 'Describe the result',
    ...(withOptions ? { options: [{ label: 'Use the standard result' }] } : {}),
  }])
  const store = createQuestionDraftStore().create(sessionId)
  const useStore: QuestionComposerProps['useStore'] = selector => useSyncExternalStore(
    listener => store.subscribe(listener),
    () => selector(store.getSnapshot()),
  )
  render(<main><QuestionComposer matched={pending} t={t} useStore={useStore} actions={store.actions} /></main>)
  const field = screen.getByRole<HTMLTextAreaElement>('textbox')
  await userEvent.fill(field, '中文输入')

  fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' }).disabled).toBe(false)

  fireEvent.compositionStart(field)
  fireEvent.keyDown(field, { key: 'Enter', isComposing: false })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' }).disabled).toBe(false)

  // Replay WebKit's compositionend-before-confirming-keydown order in one event task.
  fireEvent.compositionEnd(field, { data: '中文输入' })
  fireEvent.keyDown(field, { key: 'Enter', isComposing: false })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' }).disabled).toBe(false)
  fireEvent.compositionStart(field)
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))
  fireEvent.keyDown(field, { key: 'Enter', isComposing: false })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' }).disabled).toBe(false)
  fireEvent.compositionEnd(field, { data: '中文输入' })
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))

  await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
  expect(field.value).toBe('中文输入\n')
  const audit = await auditSurface('Question composition', document.body)
  expect(audit.passed).toBeGreaterThan(0)
  expect(audit.violations).toEqual([])
  expect(audit.incomplete).toEqual([])

  await userEvent.keyboard('{Enter}')
  await expect(pending.result).resolves.toEqual({
    answers: [{ id: 'answer', selected: [], custom: '中文输入' }],
  })
})
