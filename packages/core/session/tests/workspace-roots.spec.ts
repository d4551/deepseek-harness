/**
 * The session's additional workspace roots: the durable multi-root fact beside
 * the immutable primary `SessionHeader.cwd` — its fold, its write path, and the
 * complete root list every path-relative consumer walks.
 */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  effectiveWorkspaceRoots,
  sessionWorkspaceRoots,
  setAdditionalWorkspaceRoots,
} from '@deepseek-ai/dsh-session/workspace-roots'

const PRIMARY = resolve('/projects/primary')
const OTHER = resolve('/projects/other')
const THIRD = resolve('/projects/third')

/** `cwd: null` builds a session with no primary root at all. */
function session(id: string, cwd: string | null = PRIMARY): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: 0,
    id: sessionId,
    createdAt: 0,
    ...cwd === null ? {} : { cwd },
  })
}

describe('effectiveWorkspaceRoots', () => {
  it('folds to the last recorded set, or empty when the session never recorded one', () => {
    const active = session('sess-fold')
    expect(effectiveWorkspaceRoots(active.events)).toEqual([])
    setAdditionalWorkspaceRoots(active, [OTHER])
    expect(effectiveWorkspaceRoots(active.events)).toEqual([OTHER])
    setAdditionalWorkspaceRoots(active, [THIRD])
    expect(effectiveWorkspaceRoots(active.events)).toEqual([THIRD])
  })

  it('reconstructs the set from a replayed log, so a resumed session keeps its roots', () => {
    const active = session('sess-resume')
    setAdditionalWorkspaceRoots(active, [OTHER, THIRD])
    const resumed = Session.create(active.id, active.events, active.header)
    expect(effectiveWorkspaceRoots(resumed.events)).toEqual([OTHER, THIRD])
  })
})

describe('setAdditionalWorkspaceRoots', () => {
  it('appends one event per change and drops the primary root and duplicate spellings', () => {
    const active = session('sess-write')
    setAdditionalWorkspaceRoots(active, [OTHER, PRIMARY, OTHER, THIRD])
    const events = active.events.filter(event => event.type === 'workspace/roots')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual({ roots: [OTHER, THIRD] })
  })

  it('appends nothing when the declared set is the one the log already carries', () => {
    const active = session('sess-idempotent')
    setAdditionalWorkspaceRoots(active, [OTHER])
    setAdditionalWorkspaceRoots(active, [OTHER])
    expect(active.events.filter(event => event.type === 'workspace/roots')).toHaveLength(1)
    // A session that never widened stays free of the event entirely.
    const plain = session('sess-plain')
    setAdditionalWorkspaceRoots(plain, [])
    expect(plain.events.filter(event => event.type === 'workspace/roots')).toHaveLength(0)
  })

  it('records an explicit empty set when a widened session narrows back to its primary root', () => {
    const active = session('sess-narrow')
    setAdditionalWorkspaceRoots(active, [OTHER])
    setAdditionalWorkspaceRoots(active, [])
    expect(effectiveWorkspaceRoots(active.events)).toEqual([])
    expect(active.events.filter(event => event.type === 'workspace/roots')).toHaveLength(2)
  })

  it('rejects an empty or relative root instead of recording one no fence can match', () => {
    const active = session('sess-invalid')
    expect(() => { setAdditionalWorkspaceRoots(active, ['']) }).toThrow(/must not be empty/)
    expect(() => { setAdditionalWorkspaceRoots(active, ['relative/dir']) }).toThrow(/must be an absolute path/)
    expect(active.events.filter(event => event.type === 'workspace/roots')).toHaveLength(0)
  })
})

describe('sessionWorkspaceRoots', () => {
  it('lists the primary root first, then the recorded additional roots', () => {
    const active = session('sess-list')
    expect(sessionWorkspaceRoots(active)).toEqual([PRIMARY])
    setAdditionalWorkspaceRoots(active, [OTHER, THIRD])
    expect(sessionWorkspaceRoots(active)).toEqual([PRIMARY, OTHER, THIRD])
  })

  it('is empty for a session with neither a cwd nor recorded roots, and skips a repeated primary', () => {
    const cwdless = session('sess-cwdless', null)
    expect(sessionWorkspaceRoots(cwdless)).toEqual([])
    // A cwd-less session has no primary to exclude, so the fence root can be recorded.
    setAdditionalWorkspaceRoots(cwdless, [OTHER])
    expect(sessionWorkspaceRoots(cwdless)).toEqual([OTHER])

    const repeated = session('sess-repeated')
    repeated.append('workspace/roots', { roots: [PRIMARY, OTHER] })
    expect(sessionWorkspaceRoots(repeated)).toEqual([PRIMARY, OTHER])
  })
})
