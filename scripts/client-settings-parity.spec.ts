/**
 * Settings namespace↔surface parity: every namespace a Host package declares
 * with `settingsNamespace('<literal>')` must appear as a complete string
 * literal in a client UI source file, or appear in the explicit unbound list
 * below with a reason. A namespace that ships without a surface is silently
 * invisible to users; a stale unbound entry that gained a surface is dead
 * documentation. Both fail.
 *
 * The literal must be quoted whole. A bare substring search cannot fail for a
 * namespace named after a common word — `shell` and `permission` both occur in
 * ordinary prose and in unrelated identifiers throughout the Client — so it
 * would report parity that no surface provides.
 *
 * What this proves is that some Client source names the namespace, not that the
 * naming site is a settings binding: a file that mentions the literal for an
 * unrelated reason still satisfies it. The failure message names every file
 * that matched so a reader can check which one is the surface.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packagesRoot = join(import.meta.dirname, '../packages')

/**
 * Host namespaces with no client surface yet. Every entry needs a reason and
 * an owner decision recorded here; the gate fails if the list drifts from
 * reality in either direction.
 */
const UNBOUND_NAMESPACES: Readonly<Record<string, string>> = {}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'lib' || name === 'tests') continue
      out.push(...filesUnder(path))
    } else {
      out.push(path)
    }
  }
  return out
}

function sourceFiles(root: string, extensions: readonly string[]): string[] {
  return filesUnder(root).filter((path) => {
    const ext = path.slice(path.lastIndexOf('.'))
    return extensions.includes(ext)
  })
}

/** Every `<literal>` in a `settingsNamespace('<literal>')` call under src/. */
function hostNamespaceLiterals(): Map<string, string> {
  const found = new Map<string, string>()
  const declaration = /settingsNamespace\('([^']+)'\)/g
  for (const path of sourceFiles(packagesRoot, ['.ts'])) {
    if (path.includes('/client/')) continue // client-side namespaces own their own row by construction
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(declaration)) {
      const ns = match[1]
      if (ns === undefined) continue // the capture group is a mandatory literal
      if (found.has(ns) && found.get(ns) !== path) {
        throw new Error(`namespace '${ns}' declared twice: ${found.get(ns)} and ${path}`)
      }
      found.set(ns, path)
    }
  }
  return found
}

/**
 * Client sources naming one namespace as a complete string literal.
 * @param ns - Host namespace literal to look for.
 * @param sources - Client source paths and their text.
 * @returns Every path whose text quotes the namespace whole.
 */
function surfacesNaming(ns: string, sources: ReadonlyMap<string, string>): string[] {
  const quoted = [`'${ns}'`, `"${ns}"`, `\`${ns}\``]
  return [...sources]
    .filter(([, text]) => quoted.some(literal => text.includes(literal)))
    .map(([path]) => path)
}

/**
 * Every client UI source, read once.
 * @returns Path to text for each `.ts`/`.tsx` file under `packages/client`.
 */
function clientSourceText(): Map<string, string> {
  return new Map(
    sourceFiles(join(packagesRoot, 'client'), ['.ts', '.tsx'])
      .map(path => [path, readFileSync(path, 'utf8')] as const),
  )
}

describe('client settings namespace parity', () => {
  it('every host namespace has a client surface or a listed reason', () => {
    const declared = hostNamespaceLiterals()
    expect(declared.size).toBeGreaterThan(0)
    const clientSources = clientSourceText()
    const surfaces = new Map(
      [...declared.keys()].map(ns => [ns, surfacesNaming(ns, clientSources)] as const),
    )
    const unbound = [...surfaces].filter(([, paths]) => paths.length === 0).map(([ns]) => ns)
    const listed = Object.keys(UNBOUND_NAMESPACES).sort()

    // The named surfaces ride along so a failure says which file answers for a
    // namespace, rather than only that some file somewhere does.
    expect({ unbound: unbound.sort(), surfaces: Object.fromEntries(surfaces) })
      .toMatchObject({ unbound: listed })
  })

  it('reads a whole quoted literal, so a namespace no client names stays unbound', () => {
    const clientSources = clientSourceText()

    // 'shell' is a served namespace with a card; 'shel' is only ever a
    // substring of it, and the surface search must not answer for it.
    expect(surfacesNaming('shell', clientSources).length).toBeGreaterThan(0)
    expect(surfacesNaming('shel', clientSources)).toEqual([])
    expect(surfacesNaming('no-client-package-names-this', clientSources)).toEqual([])
  })

  it('the unbound list names only namespaces that actually exist', () => {
    const declared = hostNamespaceLiterals()
    for (const ns of Object.keys(UNBOUND_NAMESPACES)) {
      expect(declared.has(ns)).toBe(true)
    }
  })
})
