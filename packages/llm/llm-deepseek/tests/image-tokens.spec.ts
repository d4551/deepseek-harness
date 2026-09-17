import { describe, expect, it } from 'vitest'
import { deepSeekImageTokens } from '../src/image-tokens.ts'

describe('DeepSeek V4.1 image tokens', () => {
  // Reference values from the provider's published image token calculator
  // https://api-docs.deepseek.com/quick_start/token_usage/ (2026-09-16).
  it.each([
    [1, 1, 184],
    [100, 100, 184],
    [384, 384, 184],
    [544, 544, 184],
    [640, 480, 206],
    [800, 800, 422],
    [1024, 768, 496],
    [1920, 1080, 968],
    [2000, 2000, 994],
    [5000, 5000, 994],
    [300, 50, 200],
    [4921, 353, 906],
    [97, 7289, 698],
  ])('prices %sx%s as %s tokens', (width, height, expected) => {
    expect(deepSeekImageTokens(width, height)).toBe(expected)
  })

  it.each([
    { width: 2000, height: 2000 },
    { width: 5000, height: 5000 },
    { width: 8192, height: 8192 },
    { width: 16, height: 8192 },
  ])('bounds the estimate for $width x $height', ({ width, height }) => {
    expect(deepSeekImageTokens(width, height)).toBeLessThanOrEqual(1024)
  })

  it('prices small images at the documented scale-up floor', () => {
    expect(deepSeekImageTokens(100, 100)).toBe(deepSeekImageTokens(544, 544))
  })

  it('preserves wide-image geometry through the one-row solve', () => {
    expect(deepSeekImageTokens(9000, 1)).toBe(1024)
    expect(deepSeekImageTokens(8192, 100)).toBe(593)
  })

  it('solves a one-column grid for an extremely tall image', () => {
    expect(deepSeekImageTokens(16, 8192)).toBe(590)
    expect(deepSeekImageTokens(1, 9000)).toBe(1024)
  })

  it('prices odd grid heights without row alignment', () => {
    expect(deepSeekImageTokens(100, 4036)).toBe(390)
  })

  it('converges through a second projection pass when the first is not a fixpoint', () => {
    expect(deepSeekImageTokens(1, 41)).toBe(254)
    expect(deepSeekImageTokens(41, 1)).toBe(172)
    expect(deepSeekImageTokens(1, 60)).toBe(305)
    expect(deepSeekImageTokens(60, 1)).toBe(206)
  })

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid dimension %s on either axis', (dimension) => {
      expect(() => deepSeekImageTokens(dimension, 544)).toThrow(RangeError)
      expect(() => deepSeekImageTokens(544, dimension)).toThrow(RangeError)
    },
  )
})
