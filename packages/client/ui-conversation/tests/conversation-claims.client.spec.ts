// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DraftAttachmentId } from '../src/client/contract/input.ts'
import { requireBusyEnterBehavior } from '../src/submission-settings.ts'
import {
  commandPopupDismissOf, inputTriggerControllerOf, namedServiceOf,
} from '../src/client/input/optional-services.ts'
import { clipboardTransferOf } from '../src/client/skeleton/editor/keymap.ts'

describe('DraftAttachmentId', () => {
  it('mints the brand from the runtime string', () => {
    expect(DraftAttachmentId('img-1')).toBe('img-1')
  })
})

describe('requireBusyEnterBehavior', () => {
  it('claims the configured tokens and refuses anything else', () => {
    expect(requireBusyEnterBehavior('queue')).toBe('queue')
    expect(requireBusyEnterBehavior('steer')).toBe('steer')
    expect(() => requireBusyEnterBehavior('enter')).toThrow(/busy-enter behavior/)
  })
})

describe('optional sibling services', () => {
  it('resolves a session trigger controller only from a sessionOf face', () => {
    const actx = new Context()
    const resolved = { id: 'controller' }
    expect(inputTriggerControllerOf(undefined, actx)).toBeUndefined()
    expect(inputTriggerControllerOf({}, actx)).toBeUndefined()
    expect(inputTriggerControllerOf({ sessionOf: 1 }, actx)).toBeUndefined()
    expect(inputTriggerControllerOf({ sessionOf: () => resolved }, actx)).toBe(resolved)
  })

  it('resolves a popup dismiss face only from popupFor + dismiss', () => {
    const actx = new Context()
    const popup = { dismiss: () => {} }
    expect(commandPopupDismissOf(undefined, actx)).toBeUndefined()
    expect(commandPopupDismissOf({}, actx)).toBeUndefined()
    expect(commandPopupDismissOf({ popupFor: () => ({}) }, actx)).toBeUndefined()
    expect(commandPopupDismissOf({ popupFor: () => popup }, actx)).toBe(popup)
  })

  it('reads an absent named Context service as undefined', () => {
    expect(namedServiceOf(new Context(), 'inputTriggers')).toBeUndefined()
  })
})

describe('clipboardTransferOf', () => {
  it('claims duck-typed clipboardData and refuses events without it', () => {
    expect(clipboardTransferOf(new Event('paste'))).toBeUndefined()
    const bare = new Event('paste')
    Object.defineProperty(bare, 'clipboardData', { value: 'nope' })
    expect(clipboardTransferOf(bare)).toBeUndefined()
    const transfer = { items: [], getData: () => 'hello' }
    const paste = new Event('paste')
    Object.defineProperty(paste, 'clipboardData', { value: transfer })
    expect(clipboardTransferOf(paste)).toBe(transfer)
  })
})
