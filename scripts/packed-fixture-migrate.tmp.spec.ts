import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { inspectSessionFixtureLayouts } from './session-fixture-layout.ts'

const root = resolve(import.meta.dirname, '..')

it('rewrites non-canonical session fixtures in place', () => {
  const changed = inspectSessionFixtureLayouts(root).filter(f => f.source !== f.canonical)
  for (const fixture of changed) writeFileSync(resolve(root, fixture.path), fixture.canonical)
  expect(changed.map(f => f.path)).toBeDefined()
})
