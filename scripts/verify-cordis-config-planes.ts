/**
 * Host/preset plane separation and client-half declaration checks for
 * {@link ./verify-cordis-config.ts}.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isCordisGroupEntry, isJsExpr, loadCordisYaml, type CordisObject, type CordisValue } from './cordis-yaml.ts'
import type { JsonValue } from './ts7-session.ts'

/** One parsed package.json surface this gate reads. */
export interface ClientHalvesManifest {
  exports?: { [key: string]: JsonValue | undefined }
  dsh?: { [key: string]: JsonValue | undefined }
}

function isCordisObject(value: CordisValue | undefined): value is CordisObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every entry of one config file, or an empty list when it is not an entry array. */
function loadEntries(root: string, file: string): CordisValue[] {
  const document = loadCordisYaml(readFileSync(resolve(root, file), 'utf8'))
  if (!Array.isArray(document)) return []
  const entries: CordisValue[] = []
  for (const item of document) {
    if (isCordisObject(item)) entries.push(item)
  }
  return entries
}

/**
 * Row ids declared anywhere in one config file, including inside group `config`
 * lists — a preset nests most of its rows in `isolate` groups.
 * @param root - repository root.
 * @param file - repository-relative config path.
 * @returns the declared ids.
 */
function rowIds(root: string, file: string): Set<string> {
  const ids = new Set<string>()
  const walk = (value: CordisValue | undefined) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item ?? null)
      return
    }
    if (!isCordisObject(value)) return
    const id = value.id
    const name = value.name
    if (typeof id === 'string' && typeof name === 'string') ids.add(id)
    for (const child of Object.values(value)) walk(child ?? null)
  }
  for (const entry of loadEntries(root, file)) walk(entry)
  return ids
}

/**
 * No shipped agent preset may repeat a row the host composition still runs.
 * @param root - repository root.
 * @returns one diagnostic per preset row that is also active on the host plane.
 */
export function validatePresetPlaneSeparation(root: string): string[] {
  const problems: string[] = []
  const hostFile = 'packages/bundle/base/cordis.patch.yml'
  const overlayFile = 'packages/bundle/web-app/cordis.patch.yml'
  const overlay = loadEntries(root, overlayFile)
  const disabled = new Set<string>()
  for (const entry of overlay) {
    if (!isCordisObject(entry)) continue
    if (entry.disabled === true && typeof entry.id === 'string') disabled.add(entry.id)
  }
  const active = new Set([...rowIds(root, hostFile), ...rowIds(root, overlayFile)].filter(id => !disabled.has(id)))
  for (const file of globSync('packages/preset/agent-presets/presets/*/agent.cordis.yml', { cwd: root })) {
    for (const id of rowIds(root, file)) {
      if (!active.has(id)) continue
      problems.push(
        `${file}: row "${id}" is also active in the host composition; `
        + 'a row belongs to exactly one plane',
      )
    }
  }
  return problems
}

/**
 * A browser plugin must declare the browser half it ships.
 * @param root - repository root.
 * @param readManifest - parsed package.json reader.
 * @returns one violation per client package whose `./client` export and
 *   `dsh.client` declaration disagree.
 */
export function validateClientHalvesDeclared(
  root: string,
  readManifest: (path: string) => ClientHalvesManifest,
): string[] {
  return globSync('packages/client/*/package.json', { cwd: root }).flatMap((manifestPath) => {
    const manifest = readManifest(manifestPath)
    const exportsField = manifest.exports
    const shipsClient = exportsField !== undefined && Object.hasOwn(exportsField, './client')
    const declaresClient = manifest.dsh?.client !== undefined
    if (shipsClient === declaresClient) return []
    return [shipsClient
      ? `${manifestPath}: exports "./client" but declares no dsh.client, so its browser half is never served`
      : `${manifestPath}: declares dsh.client but exports no "./client" entry to serve`]
  })
}

/** Descend every row of an optional entry list field. */
function walkRowList(
  rows: Array<CordisValue | undefined> | undefined,
  file: string,
  path: string,
  field: string,
  visit: (entry: CordisObject, file: string, path: string) => void,
) {
  if (rows === undefined) return
  for (let index = 0; index < rows.length; index++) {
    forEachLoaderEntry(rows[index], file, `${path}.${field}[${index}]`, visit)
  }
}

/** Walk nested Loader entries and include-plugin patches. */
export function forEachLoaderEntry(
  value: CordisValue | undefined,
  file: string,
  path: string,
  visit: (entry: CordisObject, file: string, path: string) => void,
) {
  if (!isCordisObject(value)) return
  visit(value, file, path)
  const groupRows = isCordisGroupEntry(value) ? value.config : undefined
  walkRowList(groupRows, file, path, 'config', visit)
  walkRowList(Array.isArray(value.insert) ? value.insert : undefined, file, path, 'insert', visit)
  if (value.name !== '@deepseek-ai/cordis-plugin-include') return
  const config = value.config
  if (config === undefined || config === null || typeof config !== 'object' || Array.isArray(config)) return
  if (isJsExpr(config)) return
  const patches = config.patches
  if (!Array.isArray(patches)) return
  for (let index = 0; index < patches.length; index++) {
    const patch = patches[index]
    if (patch === undefined || !isCordisObject(patch)) continue
    const patchPath = `${path}.config.patches[${index}]`
    visit(patch, file, patchPath)
    walkRowList(Array.isArray(patch.insert) ? patch.insert : undefined, file, patchPath, 'insert', visit)
  }
}
