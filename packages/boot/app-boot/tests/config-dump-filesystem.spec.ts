import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { renderConfigDump, type ConfigDumpLayer } from '../src/index.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function baseFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-dump-filesystem-'))
  directories.push(directory)
  const path = join(directory, 'base.yml')
  writeFileSync(path, content)
  return path
}

it('keeps inserted rows and their source labels together through subsequent updates', () => {
  const path = baseFile('[]\n')
  const warnings: string[] = []
  const dump = renderConfigDump('dump-test', path, [
    { label: 'insert.yml', patches: [{ insert: [{ id: 'first', name: './first.mjs' }, { id: 'second', name: './second.mjs' }] }] },
    { label: 'unchanged.yml', patches: [{ id: 'first', name: './first.mjs' }] },
    { label: 'disable.yml', patches: [{ id: 'second', disabled: true }] },
    { label: 'last.yml', patches: [{ insert: [{ id: 'third', name: './third.mjs' }] }, { id: 'second', config: { value: 3 } }] },
  ], (line) => { warnings.push(line) })

  expect(warnings).toEqual([])
  expect(yaml.load(dump, { schema: entryListSchema })).toEqual([
    { id: 'first', name: './first.mjs' },
    { id: 'second', name: './second.mjs', disabled: true, config: { value: 3 } },
    { id: 'third', name: './third.mjs' },
  ])
  expect(dump.split('\n').filter(line => line.startsWith('# =='))).toEqual([
    '# == insert.yml',
    '# == insert.yml, patched by disable.yml, last.yml',
    '# == last.yml',
  ])
})

it('preserves layer positions and source labels when the supplied array has empty slots', () => {
  const path = baseFile('- id: original\n  name: ./original.mjs\n')
  const layers: ConfigDumpLayer[] = []
  layers[2] = { label: 'third.yml', patches: [{ id: 'original', config: { value: 'third' } }] }
  layers[4] = { label: 'fifth.yml', patches: [{ insert: [{ id: 'inserted', name: './inserted.mjs' }] }] }
  const warnings: string[] = []
  const dump = renderConfigDump('dump-test', path, layers, (line) => { warnings.push(line) })

  expect(warnings).toEqual([])
  expect(yaml.load(dump, { schema: entryListSchema })).toEqual([
    { id: 'original', name: './original.mjs', config: { value: 'third' } },
    { id: 'inserted', name: './inserted.mjs' },
  ])
  expect(dump.split('\n').filter(line => line.startsWith('# =='))).toEqual([
    '# == base.yml, patched by third.yml',
    '# == fifth.yml',
  ])
})

it('emits no provenance section for an empty composition', () => {
  const path = baseFile('[]\n')
  const warnings: string[] = []
  expect(renderConfigDump('dump-test', path, [], (line) => { warnings.push(line) })).toBe('\n')
  expect(warnings).toEqual([])
})
