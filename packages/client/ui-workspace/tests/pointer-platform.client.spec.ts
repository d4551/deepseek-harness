// @vitest-environment jsdom
/**
 * The platform split over pointer gestures: which modifier adds one row to the
 * range, and which `contextmenu` requests came from a press.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { additiveModifier, secondaryPress } from '../src/client/pointer-platform.ts'

const original = navigator.platform

/**
 * Answer `navigator.platform` with one host's reading for the next assertion.
 * @param platform - the reading the browser reports.
 */
function onPlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
}

afterEach(() => { onPlatform(original) })

describe('additive modifier', () => {
  it('takes Cmd and leaves Ctrl to the secondary menu on Apple platforms', () => {
    onPlatform('MacIntel')
    expect(additiveModifier({ ctrlKey: false, metaKey: true })).toBe(true)
    expect(additiveModifier({ ctrlKey: true, metaKey: false })).toBe(false)
  })

  it('takes Ctrl on an iPad, which shares the Apple convention', () => {
    onPlatform('iPad')
    expect(additiveModifier({ ctrlKey: true, metaKey: false })).toBe(false)
  })

  it('takes Ctrl everywhere else', () => {
    onPlatform('Win32')
    expect(additiveModifier({ ctrlKey: true, metaKey: false })).toBe(true)
    expect(additiveModifier({ ctrlKey: false, metaKey: true })).toBe(false)
  })
})

describe('secondary press', () => {
  it('reads an Apple Ctrl+click as the press it is, though it reports button 0', () => {
    onPlatform('MacIntel')
    expect(secondaryPress({ button: 0, ctrlKey: true })).toBe(true)
  })

  it('reads the same event elsewhere as the keyboard request it is', () => {
    onPlatform('Win32')
    expect(secondaryPress({ button: 0, ctrlKey: true })).toBe(false)
  })

  it('reads button 2 as a press on every platform', () => {
    onPlatform('Win32')
    expect(secondaryPress({ button: 2, ctrlKey: false })).toBe(true)
  })

  it('reads a buttonless request with no modifier as the keyboard', () => {
    onPlatform('MacIntel')
    expect(secondaryPress({ button: 0, ctrlKey: false })).toBe(false)
  })
})
