/**
 * The route join both model-selection cards read: identity, the catalog join
 * that keeps stored-but-unadvertised routes removable, and provider grouping.
 */

import { describe, expect, it } from 'vitest'
import {
  groupModelRouteCandidates,
  modelRouteCandidates,
  modelRouteKey,
  type ModelRouteCandidate,
} from '../src/client/model-route.ts'

const groups = [
  { id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }, { id: 'slow', name: 'Slow' }] },
  { id: 'beta', name: 'Beta API', models: [{ id: 'fast', name: 'Fast' }] },
]

describe('modelRouteKey', () => {
  it('gives every route a catalog advertises its own identity', () => {
    const keys = modelRouteCandidates(groups, [], new Set()).map(candidate => candidate.key)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('escapes each id, so no pair of distinct routes shares a key', () => {
    const keys = [
      modelRouteKey({ provider: 'a', model: 'b\0c' }),
      modelRouteKey({ provider: 'a\0b', model: 'c' }),
      modelRouteKey({ provider: 'a', model: 'b\\0c' }),
      modelRouteKey({ provider: 'a\\', model: '0b\0c' }),
      modelRouteKey({ provider: 'a\\0b', model: 'c' }),
    ]

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('leaves an ordinary route id untouched, so a key stays readable', () => {
    expect(modelRouteKey({ provider: 'alpha', model: 'fast' })).toBe('alpha\0fast')
  })

  it('gives one route the same identity every time', () => {
    expect(modelRouteKey({ provider: 'alpha', model: 'fast' }))
      .toBe(modelRouteKey({ provider: 'alpha', model: 'fast' }))
  })
})

describe('modelRouteCandidates', () => {
  it('joins the catalog in directory order and marks the selected rows', () => {
    expect(modelRouteCandidates(groups, [], new Set(['beta\0fast']))).toEqual([
      {
        key: 'alpha\0fast', provider: 'alpha', model: 'fast', providerName: 'Alpha API',
        modelName: 'Fast', available: true, selected: false,
      },
      {
        key: 'alpha\0slow', provider: 'alpha', model: 'slow', providerName: 'Alpha API',
        modelName: 'Slow', available: true, selected: false,
      },
      {
        key: 'beta\0fast', provider: 'beta', model: 'fast', providerName: 'Beta API',
        modelName: 'Fast', available: true, selected: true,
      },
    ])
  })

  it('keeps a stored route the catalog dropped, so the user can still remove it', () => {
    const candidates = modelRouteCandidates(
      [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
      [{ provider: 'legacy', model: 'old' }],
      new Set(['legacy\0old']),
    )

    expect(candidates).toEqual([
      {
        key: 'alpha\0fast', provider: 'alpha', model: 'fast', providerName: 'Alpha API',
        modelName: 'Fast', available: true, selected: false,
      },
      {
        key: 'legacy\0old', provider: 'legacy', model: 'old', providerName: 'legacy',
        modelName: 'old', available: false, selected: true,
      },
    ])
  })

  it('lists a stored route the catalog still advertises once, with catalog names', () => {
    const candidates = modelRouteCandidates(
      [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
      [{ provider: 'alpha', model: 'fast' }],
      new Set(['alpha\0fast']),
    )

    expect(candidates).toEqual([
      {
        key: 'alpha\0fast', provider: 'alpha', model: 'fast', providerName: 'Alpha API',
        modelName: 'Fast', available: true, selected: true,
      },
    ])
  })
})

describe('groupModelRouteCandidates', () => {
  it('groups advertised rows by provider in first-seen order', () => {
    const grouped = groupModelRouteCandidates(modelRouteCandidates(groups, [], new Set()))

    expect(grouped.unavailable).toEqual([])
    expect(grouped.available.map(group => [group.provider, group.providerName]))
      .toEqual([['alpha', 'Alpha API'], ['beta', 'Beta API']])
    expect(grouped.available.map(group => group.candidates.map(row => row.model)))
      .toEqual([['fast', 'slow'], ['fast']])
  })

  it('holds rows the catalog no longer advertises out of every provider group', () => {
    const stored: ModelRouteCandidate = {
      key: 'legacy\0old', provider: 'legacy', model: 'old', providerName: 'legacy',
      modelName: 'old', available: false, selected: true,
    }
    const grouped = groupModelRouteCandidates([...modelRouteCandidates(groups, [], new Set()), stored])

    expect(grouped.available.map(group => group.provider)).toEqual(['alpha', 'beta'])
    expect(grouped.unavailable).toEqual([stored])
  })

  it('reports no groups for an empty catalog', () => {
    expect(groupModelRouteCandidates([])).toEqual({ available: [], unavailable: [] })
  })
})
