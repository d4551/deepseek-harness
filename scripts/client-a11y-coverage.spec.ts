/**
 * The testing policy says every client UI package that ships TSX is held to
 * axe-core. A prose list of audited packages went stale, and reading the spec's
 * text for the harness name could not tell an audit from a comment mentioning
 * one — a spec whose only reference sat inside a block comment passed. The
 * predicate reads the syntax tree now, and these cases drive it against real
 * specs in this repository rather than fixtures, so what is asserted is what
 * the gate will actually see.
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packagesMissingAudit, specHoldsAxeFloor } from './client-a11y-coverage.ts'
import { parsePaths } from './ts7-session.ts'

const clientRoot = join(import.meta.dirname, '../packages/client')

/** A spec known to audit: it asserts on the failures of a real surface. */
const AUDITING = join(clientRoot, 'ui-agent-preset/tests/row.a11y.client.spec.ts')
/** This spec, which mentions every harness name in prose and audits nothing. */
const THIS_SPEC = join(import.meta.dirname, 'client-a11y-coverage.spec.ts')

describe('client UI axe coverage', () => {
  it('accepts a spec that audits a surface and asserts its failures', () => {
    const parsed = parsePaths([AUDITING])
    const source = parsed.get(AUDITING)
    expect(source).toBeDefined()
    expect(source !== undefined && specHoldsAxeFloor(source)).toBe(true)
  })

  it('refuses a file that only names the harness in prose', () => {
    // This file's own doc comment names auditSurface and accessibilityFailures
    // and it audits nothing, which is exactly the spec the text check admitted.
    const parsed = parsePaths([THIS_SPEC])
    const source = parsed.get(THIS_SPEC)
    expect(source).toBeDefined()
    expect(source !== undefined && specHoldsAxeFloor(source)).toBe(false)
  })

  it('audits every ui-* package that ships TSX', () => {
    expect(
      packagesMissingAudit(clientRoot),
      'each ui-* package with src TSX must assert accessibilityFailures on an audited surface',
    ).toEqual([])
  })
})
