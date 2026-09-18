// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { selectionIntersectsNode } from '../src/selection-intersection.ts'

describe('selectionIntersectsNode', () => {
  it('rejects a missing or collapsed selection', () => {
    const node = document.createElement('div')
    expect(selectionIntersectsNode(null, node)).toBe(false)
    expect(selectionIntersectsNode({
      isCollapsed: true,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: () => true }),
    }, node)).toBe(false)
  })

  it('accepts any intersecting range, including a later Firefox multi-range', () => {
    const node = document.createElement('div')
    expect(selectionIntersectsNode({
      isCollapsed: false,
      rangeCount: 2,
      getRangeAt: (index: number) => ({
        intersectsNode: () => index === 1,
      }),
    }, node)).toBe(true)
    expect(selectionIntersectsNode({
      isCollapsed: false,
      rangeCount: 2,
      getRangeAt: () => ({ intersectsNode: () => false }),
    }, node)).toBe(false)
  })
})
