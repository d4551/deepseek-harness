/**
 * Verify client package modes, npm dependency sections, and the synchronous
 * browser module-request graph.
 */

import { resolve } from 'node:path'
import {
  readClientDeclarations as readDeclarations,
  readFacts,
} from './verify-client-packages-facts.ts'
import { fixClientPackageManifests as fixManifests } from './verify-client-packages-fix.ts'
import {
  GATE,
  type ClientDeclaration as ClientDeclarationModel,
  type ClientPackage as ClientPackageModel,
  type ClientPackageFacts as ClientPackageFactsModel,
} from './verify-client-packages-model.ts'
import {
  collectRuntimeSourcePackageUses as runtimePackageUses,
  collectRuntimeSourceSpecifiers as runtimeSpecifiers,
  collectSourcePackageUses as sourcePackageUses,
} from './verify-client-packages-uses.ts'
import { collectClientPackageViolations as collectViolations } from './verify-client-packages-violations.ts'

export type ClientDeclaration = ClientDeclarationModel
export type ClientPackage = ClientPackageModel
export type ClientPackageFacts = ClientPackageFactsModel

/** @see {@link ./verify-client-packages-uses.ts} */
export function collectSourcePackageUses(path: string, source: string): Set<string> {
  return sourcePackageUses(path, source)
}

/** @see {@link ./verify-client-packages-uses.ts} */
export function collectRuntimeSourcePackageUses(path: string, source: string): Set<string> {
  return runtimePackageUses(path, source)
}

/** @see {@link ./verify-client-packages-uses.ts} */
export function collectRuntimeSourceSpecifiers(path: string, source: string): Set<string> {
  return runtimeSpecifiers(path, source)
}

/** @see {@link ./verify-client-packages-facts.ts} */
export function readClientDeclarations(root: string) {
  return readDeclarations(root)
}

/** @see {@link ./verify-client-packages-violations.ts} */
export function collectClientPackageViolations(facts: ClientPackageFacts) {
  return collectViolations(facts)
}

/** @see {@link ./verify-client-packages-fix.ts} */
export function fixClientPackageManifests(root: string, facts: ClientPackageFacts) {
  return fixManifests(root, facts)
}

async function main() {
  const root = resolve(import.meta.dirname, '..')
  let facts = await readFacts(root)
  if (process.argv.includes('--fix')) {
    const changed = fixClientPackageManifests(root, facts)
    process.stdout.write(
      changed.length === 0
        ? GATE + ': no mechanically fixable manifest changes.\n'
        : GATE + ': fixed ' + String(changed.length) + ' manifest(s): ' + changed.join(', ') + '\n',
    )
    facts = await readFacts(root)
  }
  const violations = collectClientPackageViolations(facts)
  if (violations.length > 0) {
    process.stderr.write(GATE + ': ' + String(violations.length) + ' violation(s):\n')
    for (const violation of violations) process.stderr.write('  ' + violation + '\n')
    process.exit(1)
  }

  const dynamic = facts.packages.filter(pkg => pkg.dynamic).length
  const requests = facts.declarations.reduce((total, pkg) => total + pkg.external.length, 0)
  process.stdout.write(
    GATE + ': ' + String(facts.packages.length) + ' client packages (' + String(dynamic) + ' dynamic, '
    + String(facts.packages.length - dynamic) + ' statically linked) satisfy dependency and module-request rules; '
    + String(requests) + ' explicit external request(s).\n',
  )
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
