/**
 * Host/preset plane separation and client-half declaration checks for
 * {@link ./verify-cordis-config.ts}.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isCordisGroupEntry, loadCordisYaml } from './cordis-yaml.ts'

function isValueObject(value: object | string | number | boolean | null | undefined): value is object {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}

/** Every entry of one config file, or an empty list when it is not an entry array. */
export function loadEntries(root: string, file: string): object[] {
  const document = loadCordisYaml(readFileSync(resolve(root, file), 'utf8'))
  if (!Array.isArray(document)) return []
  const entries: object[] = []
  for (const item of document) {
    if (isValueObject(item)) entries.push(item)
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
export function rowIds(root: string, file: string): Set<string> {
  const ids = new Set<string>()
  const walk = (value: object | string | number | boolean | null | undefined) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item === undefined ? null : item)
      return
    }
    if (!isValueObject(value)) return
    const id = Reflect.get(value, 'id')
    const name = Reflect.get(value, 'name')
    if (typeof id === 'string' && typeof name === 'string') ids.add(id)
    for (const child of Object.values(value)) walk(child === undefined ? null : child)
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
    const id = Reflect.get(entry, 'id')
    if (Reflect.get(entry, 'disabled') === true && typeof id === 'string') disabled.add(id)
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
  readManifest: (path: string) => object,
): string[] {
  return globSync('packages/client/*/package.json', { cwd: root }).flatMap((manifestPath) => {
    const manifest = readManifest(manifestPath)
    const exportsField = Reflect.get(manifest, 'exports')
    const shipsClient = exportsField !== null
      && typeof exportsField === 'object'
      && !Array.isArray(exportsField)
      && Object.hasOwn(exportsField, './client')
    const dsh = Reflect.get(manifest, 'dsh')
    const declaresClient = dsh !== null
      && typeof dsh === 'object'
      && !Array.isArray(dsh)
      && Object.hasOwn(dsh, 'client')
      && Reflect.get(dsh, 'client') !== undefined
    if (shipsClient === declaresClient) return []
    return [shipsClient
      ? `${manifestPath}: exports "./client" but declares no dsh.client, so its browser half is never served`
      : `${manifestPath}: declares dsh.client but exports no "./client" entry to serve`]
  })
}

/** Walk nested Loader entries and include-plugin patches. */
export function forEachLoaderEntry(
  value: object | string | number | boolean | null | undefined,
  file: string,
  path: string,
  visit: (entry: object, file: string, path: string) => void,
) {
  if (!isValueObject(value)) return
  visit(value, file, path)
  if (isCordisGroupEntry(value)) {
    for (let index = 0; index < value.config.length; index++) {
      const child = value.config[index]
      forEachLoaderEntry(child === undefined ? null : child, file, `${path}.config[${index}]`, visit)
    }
  }
  const insert = Reflect.get(value, 'insert')
  if (Array.isArray(insert)) {
    for (let index = 0; index < insert.length; index++) {
      const child = insert[index]
      forEachLoaderEntry(child === undefined ? null : child, file, `${path}.insert[${index}]`, visit)
    }
  }
  if (Reflect.get(value, 'name') !== '@deepseek-ai/cordis-plugin-include') return
  const config = Reflect.get(value, 'config')
  if (!isValueObject(config)) return
  const patches = Reflect.get(config, 'patches')
  if (!Array.isArray(patches)) return
  for (let index = 0; index < patches.length; index++) {
    const patch = patches[index]
    if (!isValueObject(patch)) continue
    const patchPath = `${path}.config.patches[${index}]`
    visit(patch, file, patchPath)
    const patchInsert = Reflect.get(patch, 'insert')
    if (!Array.isArray(patchInsert)) continue
    for (let insertIndex = 0; insertIndex < patchInsert.length; insertIndex++) {
      const child = patchInsert[insertIndex]
      forEachLoaderEntry(child === undefined ? null : child, file, `${patchPath}.insert[${insertIndex}]`, visit)
    }
  }
}
