/** Persisted policy bounds and the public plugin contract. */

import { expect, it } from 'vitest'
import * as Adversary from '../src/index.ts'
import { Config, assertRoutePair } from '../src/policy.ts'

it('publishes stable plugin identity and verdict accounting metadata', () => {
  expect(Adversary.name).toBe('approval-adversary')
  expect(Adversary.inject).toEqual(['approval', 'llm'])
  expect(Adversary.APPROVAL_ADVERSARY_PLUGIN).toBe('approval-adversary')
  expect(Adversary.APPROVAL_ADVERSARY_TIMEOUT_CODE).toBe('APPROVAL_ADVERSARY_TIMEOUT')
  expect(Adversary.APPROVAL_ADVERSARY_SETTINGS_NAMESPACE).toBe('approval-adversary')
  expect(Adversary.VERDICT_SUMMARIES).toEqual({
    allowed: 'adversarial review: allowed', denied: 'adversarial review: denied', unavailable: 'adversarial review: unavailable',
  })
})

it('resolves omitted composition settings through the persisted schema', () => {
  expect(Config({})).toEqual({ enabled: false, timeoutMs: 30_000, maxOutputTokens: 256, maxEvidenceChars: 4000, instructions: '' })
  expect(Adversary.APPROVAL_ADVERSARY_SETTINGS_SCHEMA).toBe(Config)
})

it.each([
  { timeoutMs: 1, maxOutputTokens: 1, maxEvidenceChars: 1, instructions: '' },
  { timeoutMs: 2_147_483_647, maxOutputTokens: 512, maxEvidenceChars: 8000, instructions: 'x'.repeat(4096) },
])('accepts the complete valid policy boundary: %j', (values) => {
  expect(Config(values)).toEqual({ enabled: false, ...values })
})

it.each([
  { timeoutMs: -1 }, { maxOutputTokens: -1 }, { maxOutputTokens: 1.5 },
  { maxEvidenceChars: -1 }, { maxEvidenceChars: 1.5 }, { instructions: 'x'.repeat(4097) },
])('rejects invalid composition values before mounting: %j', (values) => {
  expect(() => Config(values)).toThrow()
})

it.each([{ provider: 'r ', model: 'm' }, { provider: 'r', model: ' m' }])('reports whitespace in route identifiers: %j', (pair) => {
  expect(() => { assertRoutePair(Config(pair)) }).toThrow('approval-adversary: route identifiers must not contain surrounding whitespace')
})
