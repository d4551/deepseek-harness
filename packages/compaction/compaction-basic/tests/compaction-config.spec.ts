import { describe, expect, it } from 'vitest'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
} from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { MODEL } from './harness.ts'

/** The summarization target pair the inheritance tests share. */
const DEFAULT_SUMMARY_PAIR = {
  summarizationProvider: 'default-provider',
  summarizationModel: 'default-model',
}

describe('compact configuration and defaults', () => {
  it('uses low-friction service-wide defaults', () => {
    const resolved = resolveConfig({})

    expect(resolved).toEqual({
      thresholdRatio: 0.8,
      targetRatio: 0.85,
      retainRatio: 0.16,
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 8192,
      compactionRetries: 1,
      maxOverflowRetries: 1,
      modelPolicies: [],
      auto: true,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('resolves threshold and retention overrides independently', () => {
    const thresholdOnly = resolveConfig({
      thresholdRatio: 0.5,
    })
    expect(thresholdOnly).toMatchObject({
      thresholdRatio: 0.5,
      retainRatio: 0.16,
    })

    const retentionOnly = resolveConfig({
      retainTokens: 70,
    })
    expect(retentionOnly).toMatchObject({
      thresholdRatio: 0.8,
      retainTokens: 70,
    })
    expect(retentionOnly).not.toHaveProperty('retainRatio')
  })

  it('merges exact provider/model policy overrides and scales ratios per model', () => {
    const config = resolveConfig({
      thresholdRatio: 0.8,
      retainRatio: 0.1,
      modelPolicies: [{
        provider: 'small-provider',
        model: 'shared-id',
        thresholdRatio: 0.5,
        retainTokens: 120,
      }],
    })
    const small = resolveTargetPolicy(config, {
      provider: 'small-provider',
      model: 'shared-id',
    })
    const otherProvider = resolveTargetPolicy(config, {
      provider: 'large-provider',
      model: 'shared-id',
    })

    expect(resolveCompactSpec(small, 1_000)).toMatchObject({
      thresholdTokens: 500,
      retainTokens: 120,
    })
    expect(resolveCompactSpec(otherProvider, 2_000)).toMatchObject({
      thresholdTokens: 1_600,
      retainTokens: 200,
    })

    const ratioOverride = resolveTargetPolicy(resolveConfig({
      retainTokens: 200,
      modelPolicies: [{
        provider: 'ratio-provider',
        model: 'ratio-model',
        thresholdRatio: 0.6,
        targetRatio: 0.5,
        retainRatio: 0.2,
        summarizationProvider: 'summary-provider',
        summarizationModel: 'summary-model',
        maxTokens: 512,
        compactionRetries: 2,
        maxOverflowRetries: 3,
      }],
    }), { provider: 'ratio-provider', model: 'ratio-model' })
    expect(resolveCompactSpec(ratioOverride, 2_000)).toMatchObject({
      thresholdTokens: 1_200,
      targetTokens: 600,
      retainTokens: 400,
      summarizationProvider: 'summary-provider',
      summarizationModel: 'summary-model',
      maxTokens: 512,
      compactionRetries: 2,
      maxOverflowRetries: 3,
    })
  })

  it('inherits, clears, and replaces the summarization target as a pair', () => {
    const config = resolveConfig({
      ...DEFAULT_SUMMARY_PAIR,
      modelPolicies: [
        { provider: 'inherit-provider', model: MODEL },
        {
          provider: 'clear-provider',
          model: MODEL,
          summarizationProvider: '',
          summarizationModel: '',
        },
        {
          provider: 'replace-provider',
          model: MODEL,
          summarizationProvider: 'replacement-provider',
          summarizationModel: 'replacement-model',
        },
      ],
    })

    expect(resolveTargetPolicy(config, { provider: 'inherit-provider', model: MODEL }))
      .toMatchObject({
        summarizationProvider: 'default-provider',
        summarizationModel: 'default-model',
      })
    expect(resolveTargetPolicy(config, { provider: 'clear-provider', model: MODEL }))
      .toMatchObject({ summarizationProvider: '', summarizationModel: '' })
    expect(resolveTargetPolicy(config, { provider: 'replace-provider', model: MODEL }))
      .toMatchObject({
        summarizationProvider: 'replacement-provider',
        summarizationModel: 'replacement-model',
      })
  })

  it('validates common values and pressure-policy invariants', () => {
    const bad = [
      [{ maxTokens: 0 }, /maxTokens/],
      [{ compactionRetries: -1 }, /compactionRetries/],
      [{ maxOverflowRetries: -1 }, /maxOverflowRetries/],
      [{ auto: 'yes' }, /auto must be a boolean/],
      [{ summarizationProvider: 1 }, /summarizationProvider must be a string/],
      [{ summarizationModel: 1 }, /summarizationModel must be a string/],
      [{ summarizationProvider: MODEL }, /must be set together/],
      [{ summarizationModel: MODEL }, /must be set together/],
      [{ summarizationProvider: '' }, /must be set together/],
      [{ summarizationModel: '' }, /must be set together/],
      [{ thresholdRatio: 0 }, /number in \(0, 1\]/],
      [{ thresholdRatio: 1.1 }, /number in \(0, 1\]/],
      [{ retainRatio: 0.9 }, /retainRatio \(0.9\) must be less than the resolved thresholdRatio \(0.8\)/],
      [{ thresholdRatio: 0.1 }, /retainRatio \(0.16\) must be less than the resolved thresholdRatio \(0.1\)/],
      [{ retainTokens: -1 }, /non-negative integer/],
      [{ retainRatio: 0.2, retainTokens: 100 }, /mutually exclusive/],
      [{ modelPolicies: {} }, /modelPolicies must be an array/],
      [{ modelPolicies: [1] }, /modelPolicies\[0\] must be an object/],
      [{ modelPolicies: [null] }, /modelPolicies\[0\] must be an object/],
      [{ modelPolicies: [[]] }, /modelPolicies\[0\] must be an object/],
      [{ modelPolicies: [{ provider: 1, model: MODEL }] }, /provider must be a non-empty string/],
      [{ modelPolicies: [{ provider: '', model: MODEL }] }, /provider must be a non-empty string/],
      [{ modelPolicies: [{ provider: MODEL, model: 1 }] }, /model must be a non-empty string/],
      [{ modelPolicies: [{ provider: MODEL, model: '' }] }, /model must be a non-empty string/],
      [{ modelPolicies: [{ provider: MODEL, model: MODEL, summarizationProvider: 1 }] }, /summarizationProvider must be a string/],
      [{
        ...DEFAULT_SUMMARY_PAIR,
        modelPolicies: [{ provider: MODEL, model: MODEL, summarizationModel: '' }],
      }, /modelPolicies\[0\].*must be set together/],
      [{
        ...DEFAULT_SUMMARY_PAIR,
        modelPolicies: [{ provider: MODEL, model: MODEL, summarizationProvider: '' }],
      }, /modelPolicies\[0\].*must be set together/],
      [{ modelPolicies: [{ provider: MODEL, model: MODEL, retainRatio: 0.2, retainTokens: 100 }] }, /mutually exclusive/],
      [
        { modelPolicies: [{ provider: MODEL, model: MODEL, thresholdRatio: 0.1 }] },
        /modelPolicies\[0\]: retainRatio \(0.16\).*thresholdRatio \(0.1\)/,
      ],
      [
        { modelPolicies: [{ provider: MODEL, model: MODEL, retainRatio: 0.9 }] },
        /modelPolicies\[0\]: retainRatio \(0.9\).*thresholdRatio \(0.8\)/,
      ],
      [{ modelPolicies: [{ provider: MODEL, model: MODEL }, { provider: MODEL, model: MODEL }] }, /duplicate model policy/],
      [{ models: { [MODEL]: { retainTokens: 10 } } }, /key "models"/],
      [{ thresholdRato: 0.5 }, /key "thresholdRato"/],
    ]

    for (const [config, pattern] of bad) {
      expect(() => resolveConfig(config as BasicCompactionConfig)).toThrow(pattern)
    }

    const invalidPressure = resolveTargetPolicy(resolveConfig({
      thresholdRatio: 0.5,
      retainTokens: 500,
    }), { provider: MODEL, model: MODEL })
    expect(() => resolveCompactSpec(invalidPressure, 1_000)).toThrow(/less than threshold/)
    expect(() => resolveCompactSpec(invalidPressure, 1.5)).toThrow(/positive integer/)
    expect(() => resolveCompactSpec(invalidPressure, 0)).toThrow(/positive integer/)
  })
})
