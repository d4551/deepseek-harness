/**
 * What still reads `pnpm`, held to the account the conversion note gives.
 *
 * The note enumerates where the word survives. A prose list is a claim about
 * the whole tree that nothing checks, and it was wrong once: it cited a
 * Vendoring Policy exemption covering no files while omitting most of its
 * subject. This asserts the enumeration is exhaustive, so a new occurrence
 * outside it fails here instead of quietly making the note untrue.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

/** Every tracked file containing the word, by repository-relative path. */
function filesMentioningPnpm(): string[] {
  const tracked = execFileSync('git', ['grep', '-l', '--', 'pnpm'], { cwd: root, encoding: 'utf8' })
  return tracked.split('\n').filter(line => line !== '').sort()
}

/**
 * Comments that state a fact about another tool rather than about this
 * repository: what corepack provides shims for, and which values Stryker's
 * `packageManager` option accepts. Naming them individually keeps the
 * exemption from widening into "any source file may mention it".
 */
const EXTERNAL_TOOL_FACTS: readonly string[] = [
  'scripts/ci-workflow.spec.ts',
  'stryker.config.mjs',
]

/**
 * Records of the conversion itself: the note that decided it, the loop record
 * that tracks what the audit found, and this gate. They name the word because
 * it is their subject.
 */
const CONVERSION_RECORDS: readonly string[] = [
  '.agents/audit-loop.md',
  'scripts/bun-conversion-residue.spec.ts',
]

describe('pnpm residue after the bun conversion', () => {
  const files = filesMentioningPnpm()

  it('finds the corpus it is auditing', () => {
    // Were the search to return nothing, every assertion below would hold
    // vacuously and the gate would pass on a tree it never read.
    expect(files.length).toBeGreaterThan(100)
  })

  it('leaves the word only where the conversion note accounts for it', () => {
    const unaccounted = files.filter(file => !(
      file.startsWith('.agents/notes/archived/')
      || file.startsWith('.agents/notes/implemented/')
      || (file.startsWith('packages/client/') && file.includes('/tests/'))
      || EXTERNAL_TOOL_FACTS.includes(file)
      || CONVERSION_RECORDS.includes(file)
    ))
    expect(unaccounted, 'every occurrence must fall in a category the bun note names').toEqual([])
  })

  it('holds the executable surface clear of it', () => {
    // The conversion is about what runs. Workflows, package manifests, the
    // lockfile and the launchers are where a stale verb stops a build rather
    // than merely reading oddly.
    const executable = files.filter(file => (
      file.startsWith('.github/workflows/')
      || file === '.gitlab-ci.yml'
      || file === 'lefthook.yml'
      || file.endsWith('package.json')
      || file === 'bun.lock'
      || file.startsWith('apps/')
      || file.startsWith('native/')
    ))
    expect(executable, 'no executable path may still drive pnpm').toEqual([])
  })
})
