/**
 * The testing policy says every client UI package that ships TSX is held to
 * axe-core. A prose list of audited packages went stale; this asserts the
 * import exists in that package's own tests so a new ui-* surface cannot
 * ship without an audit.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const clientRoot = join(import.meta.dirname, '../packages/client')
const A11Y_IMPORT = "from '@deepseek-ai/dsh-client-a11y'"

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
}

function uiPackagesWithTsx(): string[] {
  return readdirSync(clientRoot).filter((name) => {
    if (!name.startsWith('ui-')) return false
    const src = join(clientRoot, name, 'src')
    if (!existsSync(src)) return false
    return filesUnder(src).some(path => path.endsWith('.tsx'))
  }).sort()
}

function packageAuditsAxe(name: string): boolean {
  const tests = join(clientRoot, name, 'tests')
  if (!existsSync(tests)) return false
  return filesUnder(tests).some((path) => {
    if (!path.includes('.spec.')) return false
    const source = readFileSync(path, 'utf8')
    return source.includes(A11Y_IMPORT) && source.includes('auditSurface(')
  })
}

describe('client UI axe coverage', () => {
  it('audits every ui-* package that ships TSX', () => {
    const missing = uiPackagesWithTsx().filter(name => !packageAuditsAxe(name))
    expect(missing, 'each ui-* package with src TSX must import @deepseek-ai/dsh-client-a11y in a spec').toEqual([])
  })
})
