/**
 * Policy diagnostics for {@link ./verify-client-packages.ts}.
 */

import {
  CORDIS,
  PARSER_PRELOAD_SOURCE,
  PLATFORM_SOURCE,
  declaredSections,
  describeOrigins,
  describeRangeMismatch,
  describeSections,
  expectedSections,
  isInternalDsh,
  packageNameOf,
  rowNames,
  rowPackageOf,
  stripClientSuffix,
  type ClientDeclaration,
  type ClientPackageFacts,
} from './verify-client-packages-model.ts'

interface ModuleEdge {
  readonly from: string
  readonly to: string
  readonly specifier: string
}

function collectModeViolations(facts: ClientPackageFacts): string[] {
  const violations: string[] = []
  for (const pkg of facts.packages) {
    if (pkg.dynamic && pkg.staticLinked) {
      violations.push(
        pkg.manifest + ': ' + pkg.name + ' declares dsh.client and uses the staticLinked preset;'
        + ' a client package must be dynamic or statically linked, not both',
      )
    } else if (!pkg.dynamic && !pkg.staticLinked) {
      violations.push(
        pkg.manifest + ': ' + pkg.name + ' has no supported client package mode;'
        + ' declare dsh.client or use the staticLinked preset',
      )
    }
  }

  const workspaceNames = new Set(facts.declarations.map(entry => entry.name))
  for (const specifier of facts.platformModules) {
    const owner = packageNameOf(specifier)
    if (!workspaceNames.has(owner) || owner === CORDIS || facts.staticLinkedPackages.has(owner)) continue
    violations.push(
      PLATFORM_SOURCE + ': seeded workspace module ' + JSON.stringify(specifier)
      + ' belongs to ' + owner + ', whose build does not use the staticLinked preset',
    )
  }

  const rows = rowNames(facts.declarations)
  for (const specifier of facts.preloadedExternals) {
    if (rowPackageOf(specifier, rows) === undefined) {
      violations.push(
        PLATFORM_SOURCE + ': parser-preloaded external ' + JSON.stringify(specifier)
        + ' has no dynamic dsh.client row',
      )
    }
    if (!facts.parserPreloadIds.includes(stripClientSuffix(specifier))) {
      violations.push(
        PLATFORM_SOURCE + ': parser-preloaded external ' + JSON.stringify(specifier)
        + ' has no matching PARSER_PRELOAD_IDS row in ' + PARSER_PRELOAD_SOURCE,
      )
    }
  }
  return violations
}

function collectDependencyViolations(facts: ClientPackageFacts): string[] {
  const violations: string[] = []
  const staticInputs = new Set([
    ...facts.staticLinkedPackages,
    ...facts.platformModules.map(packageNameOf),
  ])
  staticInputs.delete(CORDIS)

  for (const pkg of [...facts.packages].sort((left, right) => left.manifest.localeCompare(right.manifest))) {
    const expected = expectedSections(pkg, staticInputs)
    for (const [name, rule] of [...expected].sort(([left], [right]) => left.localeCompare(right))) {
      const actual = declaredSections(pkg, name)
      if (rule.kind === 'dependency') {
        if (actual.length === 1 && actual[0] === 'dependencies') continue
        violations.push(
          pkg.manifest + ': ' + name + ' (' + describeOrigins(rule.origins) + ') is a runtime import'
          + ' retained by a statically linked artifact; declare it only in dependencies, found '
          + describeSections(actual),
        )
        continue
      }
      if (rule.kind === 'dev') {
        if (actual.length === 1 && actual[0] === 'devDependencies') continue
        violations.push(
          pkg.manifest + ': ' + name + ' (' + describeOrigins(rule.origins) + ') is a static client input;'
          + ' declare it only in devDependencies, found ' + describeSections(actual),
        )
        continue
      }

      const peerRange = pkg.peerDependencies[name]
      const devRange = pkg.devDependencies[name]
      if (actual.length === 2
        && actual.includes('peerDependencies')
        && actual.includes('devDependencies')
        && peerRange === devRange) continue
      violations.push(
        pkg.manifest + ': ' + name + ' (' + describeOrigins(rule.origins) + ')'
        + ' is a peer-installed DSH relationship; declare it in peerDependencies and devDependencies'
        + ' with matching ranges, not dependencies; found ' + describeSections(actual)
        + describeRangeMismatch(peerRange, devRange),
      )
    }

    for (const [name, peerRange] of Object.entries(pkg.peerDependencies).sort(([left], [right]) => left.localeCompare(right))) {
      if (expected.has(name)) continue
      const devRange = pkg.devDependencies[name]
      if (devRange === peerRange) continue
      violations.push(
        pkg.manifest + ': peerDependencies.' + name + ' is ' + peerRange + ', so devDependencies.' + name
        + ' must use the same range; found ' + (devRange ?? 'no declaration'),
      )
    }

    if (!pkg.dynamic) continue
    for (const section of ['dependencies', 'peerDependencies'] as const) {
      for (const name of Object.keys(pkg[section]).sort()) {
        if (expected.has(name)) continue
        if (staticInputs.has(name)) {
          violations.push(
            pkg.manifest + ': dynamic package declares static input ' + name + ' in ' + section + ';'
            + ' move it to devDependencies or delete the stale declaration',
          )
        } else if (section === 'dependencies' && isInternalDsh(name)) {
          violations.push(
            pkg.manifest + ': dynamic package declares ' + name + ' in dependencies;'
            + ' dynamic DSH relationships are peer plus dev, and static client inputs are dev-only',
          )
        }
      }
    }
  }
  return violations
}

function cycleKey(cycle: readonly ModuleEdge[]): string {
  const labels = cycle.map(edge => edge.from + ' ' + edge.specifier)
  const first = [...labels].sort()[0]
  const offset = first === undefined ? 0 : labels.indexOf(first)
  return [...labels.slice(offset), ...labels.slice(0, offset)].join(' -> ')
}

function formatCycle(
  cycle: readonly ModuleEdge[],
  byName: ReadonlyMap<string, ClientDeclaration>,
): string {
  const entry = cycle[0]
  const chain = cycle.map(edge => edge.from + ' --(' + edge.specifier + ')-->').join(' ')
  const manifest = entry === undefined ? 'packages/client' : byName.get(entry.from)?.manifest ?? entry.from
  return manifest + ': synchronous dsh.client.external cycle: ' + chain + ' ' + (entry?.from ?? '')
}

function collectModuleCycles(
  edges: readonly ModuleEdge[],
  byName: ReadonlyMap<string, ClientDeclaration>,
): string[] {
  const outgoing = new Map<string, ModuleEdge[]>()
  for (const edge of [...edges].sort((left, right) => left.specifier.localeCompare(right.specifier))) {
    outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge])
  }
  const finished = new Set<string>()
  const onPath = new Set<string>()
  const path: ModuleEdge[] = []
  const reported = new Map<string, string>()

  const walk = (name: string): void => {
    onPath.add(name)
    for (const edge of outgoing.get(name) ?? []) {
      if (onPath.has(edge.to)) {
        const start = path.findIndex(entry => entry.from === edge.to)
        const cycle = start === -1 ? [edge] : [...path.slice(start), edge]
        const key = cycleKey(cycle)
        if (!reported.has(key)) reported.set(key, formatCycle(cycle, byName))
      } else if (!finished.has(edge.to)) {
        path.push(edge)
        walk(edge.to)
        path.pop()
      }
    }
    onPath.delete(name)
    finished.add(name)
  }

  for (const name of [...outgoing.keys()].sort()) {
    if (!finished.has(name)) walk(name)
  }
  return [...reported.values()]
}

function collectModuleViolations(facts: ClientPackageFacts): string[] {
  const violations: string[] = []
  const baseline = new Set([...facts.platformModules, ...facts.preloadedExternals])
  const rows = rowNames(facts.declarations)
  const byName = new Map(facts.declarations.map(entry => [entry.name, entry]))
  const edges: ModuleEdge[] = []

  for (const pkg of facts.declarations.filter(entry => entry.dynamic)) {
    for (const field of ['external', 'inject'] as const) {
      const seen = new Set<string>()
      for (const value of pkg[field]) {
        if (value === '') violations.push(pkg.manifest + ': dsh.client.' + field + ' contains an empty value')
        else if (seen.has(value)) {
          violations.push(pkg.manifest + ': dsh.client.' + field + ' lists ' + JSON.stringify(value) + ' twice')
        }
        seen.add(value)
      }
    }

    for (const specifier of new Set(pkg.external)) {
      if (specifier === '') continue
      if (baseline.has(specifier)) {
        violations.push(
          pkg.manifest + ': dsh.client.external repeats baseline module ' + JSON.stringify(specifier)
          + '; remove the explicit declaration',
        )
        continue
      }
      const supplier = rowPackageOf(specifier, rows)
      if (supplier === pkg.name) {
        violations.push(pkg.manifest + ': dsh.client.external names its own row ' + JSON.stringify(specifier))
      } else if (supplier !== undefined) {
        if (pkg.manifest.startsWith('packages/client/')) {
          violations.push(
            pkg.manifest + ': client feature package requests runtime external ' + JSON.stringify(specifier)
            + '; import shared types only or call an injected Cordis service',
          )
          continue
        }
        if (pkg.runtimeSourceSpecifiers[specifier] === undefined) {
          violations.push(
            pkg.manifest + ': dsh.client.external ' + JSON.stringify(specifier)
            + ' has no runtime import or re-export in production source; remove the stale declaration',
          )
          continue
        }
        edges.push({ from: pkg.name, to: supplier, specifier })
      } else {
        const owner = stripClientSuffix(specifier)
        violations.push(
          pkg.manifest + ': dsh.client.external ' + JSON.stringify(specifier) + ' has no supplier;'
          + (byName.has(owner)
            ? ' workspace package ' + owner
              + ' declares no dynamic dsh.client row and the shell does not seed this specifier'
            : ' no dynamic row or PLATFORM_MODULES entry answers it'),
        )
      }
    }
  }

  violations.push(...collectModuleCycles(edges, byName))
  return violations
}

/**
 * Return every client package policy violation.
 * @param facts - Package modes, manifests, source uses, and platform module lists.
 * @returns Stable self-contained diagnostics.
 */
export function collectClientPackageViolations(facts: ClientPackageFacts): string[] {
  return [
    ...facts.malformed,
    ...collectModeViolations(facts),
    ...collectDependencyViolations(facts),
    ...collectModuleViolations(facts),
  ].sort((left, right) => left.localeCompare(right))
}
