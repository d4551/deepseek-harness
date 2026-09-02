/**
 * Refuse a dependency that is behind a version this workspace could install.
 *
 * The toolchain and live-stack floors catch a downgrade: a coordinated edit
 * that moves a caret range below its floor fails. Nothing caught the floors
 * themselves going stale, so every pin could sit a year behind the registry
 * with every gate green — the drift the floors exist to prevent, in the one
 * direction they cannot see.
 *
 * The report comes from `bun outdated` rather than from the registry directly.
 * Asking npm would mean reimplementing range resolution, workspace filtering
 * and the `minimumReleaseAge` hold in `bunfig.toml`, and the answer would drift
 * from what `bun install` actually does; the package manager already knows all
 * three.
 *
 * A version the hold is withholding is not a failure. That hold is this
 * repository's own supply-chain policy — a newly published version is not
 * installable until it has been on the registry long enough to be withdrawn —
 * so a held row is the policy working, and failing on it would make going green
 * require bypassing it.
 *
 * @module scripts/verify-installable-versions
 */

import { spawnSync } from 'node:child_process'

/** One row of the `bun outdated` table. */
export interface OutdatedRow {
  /** Package name, without the `(dev)` or `(peer)` suffix the table appends. */
  readonly name: string
  /** The version installed now. */
  readonly current: string
  /** The newest version published, whether or not the hold admits it yet. */
  readonly latest: string
  /** Whether the hold is why the newest version is not installed. */
  readonly held: boolean
}

/** The cells of one table row, or undefined for a rule, header or note. */
function cellsOf(line: string): string[] | undefined {
  if (!line.startsWith('|') || line.startsWith('|--')) return undefined
  const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
  return cells.length === 4 ? cells : undefined
}

/**
 * Read the `bun outdated` table.
 * @param output - what the command printed.
 * @returns one entry per package the table lists, in table order.
 */
export function parseOutdated(output: string): OutdatedRow[] {
  const rows: OutdatedRow[] = []
  for (const line of output.split('\n')) {
    const cells = cellsOf(line)
    if (cells === undefined) continue
    const [name = '', current = '', update = '', latest = ''] = cells
    if (name === 'Package') continue
    rows.push({
      name: name.replace(/\s*\((?:dev|peer|optional)\)$/u, '').trim(),
      current: current.trim(),
      latest: latest.replace('*', '').trim(),
      // The marker sits on whichever column the hold applies to.
      held: update.includes('*') || latest.includes('*'),
    })
  }
  return rows
}

/**
 * The packages behind a version this workspace could install today.
 *
 * Read from the newest published version, not from the table's in-range
 * "Update" column: an exactly pinned dependency has an in-range target equal to
 * what is already installed, so a check against that column can never fire.
 * @param rows - the parsed table.
 * @returns one line per package that is behind, empty when none is.
 */
export function behindInstallable(rows: readonly OutdatedRow[]): string[] {
  return rows
    .filter(row => !row.held && row.latest !== '' && row.latest !== row.current)
    .map(row => `${row.name} is at ${row.current} and ${row.latest} is installable now`)
}

/**
 * The packages the supply-chain hold is withholding a newer version from.
 * @param rows - the parsed table.
 * @returns one line per held package, for the report.
 */
export function heldByPolicy(rows: readonly OutdatedRow[]): string[] {
  return rows.filter(row => row.held).map(row => `${row.name} ${row.current}`)
}

/**
 * Read `bun outdated` and report what is behind.
 * @returns the exit code: 0 when nothing is behind, 1 otherwise.
 */
export function verifyInstallableVersions(): number {
  const run = spawnSync('bun', ['outdated'], { encoding: 'utf8' })
  if (run.status !== 0) {
    process.stderr.write(`verify-installable-versions: bun outdated exited ${String(run.status)}\n${run.stderr}`)
    return 1
  }
  const rows = parseOutdated(run.stdout)
  const held = heldByPolicy(rows)
  if (held.length > 0) {
    process.stdout.write(`held by the supply-chain hold, which is the hold working: ${held.join(', ')}\n`)
  }
  const behind = behindInstallable(rows)
  if (behind.length > 0) {
    process.stderr.write(
      `verify-installable-versions: dependencies behind an installable version:\n  ${behind.join('\n  ')}\n`,
    )
    return 1
  }
  process.stdout.write(
    `every dependency is at the newest version this workspace can install (${String(rows.length)} reported)\n`,
  )
  return 0
}

if (import.meta.main) process.exit(verifyInstallableVersions())
