/**
 * Generate `docs/config-catalog.md` from package entry points, config types,
 * JSDoc, and static Schemastery schemas. Every package must classify, referenced
 * types must resolve without collisions, and every enumerable schema path must
 * exist on the declared config type. External and dynamic types stay unknown;
 * declared runtime-only fields need not appear in the schema. `--check` verifies
 * the committed artifact.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectConfigCatalog as collectEntries } from './gen-config-catalog-collect.ts'
import type { CatalogEntry as CatalogEntryModel } from './gen-config-catalog-model.ts'
import { renderCatalog } from './gen-config-catalog-render.ts'

export type CatalogEntry = CatalogEntryModel

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/config-catalog.md'

/**
 * Walk every `packages/<group>/<pkg>` entry and build the catalog entries.
 * @param scanRoot - repository or fixture root.
 * @returns sorted catalog entries.
 */
export function collectConfigCatalog(scanRoot: string = root): CatalogEntry[] {
  return collectEntries(scanRoot)
}

/**
 * Render the full catalog (pure, deterministic given sorted entries).
 * @param entries - sorted catalog entries.
 * @returns markdown document text.
 */
export function render(entries: CatalogEntry[]): string {
  return renderCatalog(entries)
}

function main() {
  const content = render(collectConfigCatalog())
  if (process.argv.includes('--check')) {
    const committed = existsSync(resolve(root, OUT)) ? readFileSync(resolve(root, OUT), 'utf8') : ''
    if (committed === content) {
      process.stdout.write(`gen-config-catalog: ${OUT} is up to date.\n`)
      process.exit(0)
    }
    process.stderr.write(`gen-config-catalog: ${OUT} is stale. Run \`bun run gen-config-catalog\` and commit ${OUT}.\n`)
    process.exit(1)
  }
  writeFileSync(resolve(root, OUT), content)
  process.stdout.write(`gen-config-catalog: wrote ${OUT}.\n`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
