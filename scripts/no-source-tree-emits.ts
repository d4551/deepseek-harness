/**
 * Compiler output must never land beside the sources it was built from.
 *
 * `docs/development.md` states the layout rule — every package sets `rootDir:
 * src` and `outDir: lib/types` — but nothing enforced it, and a misconfigured
 * program breaks it silently. A `tsconfig` whose `rootDir` cannot contain a
 * file it pulled in emits that file in place instead, so one test importing
 * across a plane boundary scattered 148 `.js`, `.js.map`, `.d.ts` and
 * `.d.ts.map` files through twelve packages' `src/` trees.
 *
 * The damage is not the clutter. Vite resolves `.js` before `.ts` for a
 * directory entry, so every lane importing such a package silently loaded a
 * frozen artifact instead of the source it was editing, and reported results
 * for code that was no longer on disk. 111 of those files reached the git
 * index before anyone noticed.
 *
 * @module scripts/no-source-tree-emits
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** One compiler artifact found inside a source tree. */
export interface SourceEmitFinding {
  /** Repository-relative path of the offending file. */
  file: string
  /** Why the file is an artifact rather than authored source. */
  detail: string
}

const ROOT = resolve(import.meta.dirname, '..')

/** Trees that hold authored sources, each scanned for build output. */
const SOURCE_ROOTS = ['packages', 'apps', 'vendor', 'scripts'] as const

/** Directories that legitimately hold build output or foreign files. */
const SKIPPED = new Set(['node_modules', 'lib', 'dist', 'coverage', '.git'])

/** Extensions nobody authors: a source map only ever comes from a compiler. */
const ALWAYS_EMITTED = ['.js.map', '.mjs.map', '.cjs.map', '.d.ts.map']

/**
 * Script extensions that are authored constantly — fixtures, bins, config —
 * and are only an artifact when they shadow a module of the same stem.
 */
const SHADOWING = ['.js', '.mjs', '.cjs']

/**
 * Whether a file shadows an authored module of the same stem.
 *
 * This is the property that makes an artifact harmful rather than untidy: a
 * standalone `bin.js` or `fixture.mjs` is authored source, while a `foo.js`
 * beside `foo.ts` is what Vite resolves first. Ambient declarations
 * (`css-modules.d.ts`, `vite-env.d.ts`) stand alone for the same reason.
 * @param file - absolute path of the candidate.
 * @param suffix - the suffix to strip before looking for a module sibling.
 * @returns true when a `.ts` or `.tsx` sibling of the same stem exists.
 */
function shadowsAuthoredModule(file: string, suffix: string): boolean {
  const stem = file.slice(0, -suffix.length)
  return existsSync(`${stem}.ts`) || existsSync(`${stem}.tsx`)
}

/**
 * Every compiler artifact sitting inside a source tree.
 * @param root - repository root; defaults to this script's parent.
 * @returns one finding per artifact, in directory-walk order.
 */
export function auditSourceTreeEmits(root: string = ROOT): SourceEmitFinding[] {
  const findings: SourceEmitFinding[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const mapSuffix = ALWAYS_EMITTED.find(candidate => entry.name.endsWith(candidate))
      if (mapSuffix !== undefined) {
        findings.push({
          file: relative(root, path).replaceAll('\\', '/'),
          detail: `a compiler wrote this ${mapSuffix}; source maps are never authored, so the emitting project's outDir is wrong`,
        })
        continue
      }
      if (entry.name.endsWith('.d.ts')) {
        if (shadowsAuthoredModule(path, '.d.ts')) {
          findings.push({
            file: relative(root, path).replaceAll('\\', '/'),
            detail: 'an emitted declaration shadows the .ts it was generated from; delete it and fix the emitting project',
          })
        }
        continue
      }
      const scriptSuffix = SHADOWING.find(candidate => entry.name.endsWith(candidate))
      if (scriptSuffix !== undefined && shadowsAuthoredModule(path, scriptSuffix)) {
        findings.push({
          file: relative(root, path).replaceAll('\\', '/'),
          detail: `a build wrote this ${scriptSuffix} beside its source; Vite resolves it ahead of the .ts, so lanes load the artifact`,
        })
      }
    }
  }
  for (const name of SOURCE_ROOTS) {
    const dir = resolve(root, name)
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
  }
  return findings
}
