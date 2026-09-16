import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider, parseCredentialsDocument } from '../src/index.ts'

const ref = credentialRef('DSH_ALIAS_KEY')
const neighbor = credentialRef('DSH_ALIAS_NEIGHBOR')
const account = credentialKey('llm-provider', 'account')
const other = credentialKey('llm-provider', 'other')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function seed(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-credential-alias-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, '.credentials.yaml')
  await writeFile(path, text, { mode: 0o600 })
  return path
}

async function boot(path: string): Promise<Context> {
  const context = new Context()
  const fiber = context.plugin(LocalCredentialProvider, { path, watch: false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return context
}

describe('credential YAML alias ownership', () => {
  it.each(['set', 'unset'])('%s edits an aliased refs map without changing its grant source', async (operation) => {
    const original = 'version: 1\nrecords:\n  llm-provider/account:\n    kind: grant\n'
      + '    payload: &shared {DSH_ALIAS_KEY: synthetic, DSH_ALIAS_NEIGHBOR: "retained"} # grant comment\n'
      + 'refs: *shared # refs comment\n'
    const path = await seed(original)
    const context = await boot(path)
    expect(await context.credentials.resolve(ref)).toEqual({ value: 'synthetic', source: 'file' })

    if (operation === 'set') await context.credentials.set(ref, 'replacement')
    else await context.credentials.unset(ref)

    const text = await readFile(path, 'utf8')
    expect(text).toContain('payload: &shared { DSH_ALIAS_KEY: synthetic, DSH_ALIAS_NEIGHBOR: "retained" } # grant comment')
    expect(text).toContain('# refs comment')
    for (const reader of [context, await boot(path)]) {
      expect(await reader.credentials.readRecord(account)).toEqual({
        kind: 'grant', payload: { DSH_ALIAS_KEY: 'synthetic', DSH_ALIAS_NEIGHBOR: 'retained' },
      })
      expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'retained', source: 'file' })
      expect(await reader.credentials.resolve(ref)).toEqual(operation === 'set'
        ? { value: 'replacement', source: 'file' } : undefined)
    }
  })

  it.each(['set', 'unset'])('%s isolates a refs map from grant aliases of that map', async (operation) => {
    const path = await seed('version: 1\nrefs: &shared\n  DSH_ALIAS_KEY: synthetic\n'
      + '  DSH_ALIAS_NEIGHBOR: "retained" # neighbor comment\nrecords:\n'
      + '  llm-provider/account:\n    kind: grant\n    payload: *shared # grant comment\n')
    const context = await boot(path)

    if (operation === 'set') await context.credentials.set(ref, 'replacement')
    else await context.credentials.unset(ref)

    const text = await readFile(path, 'utf8')
    expect(text).toContain('DSH_ALIAS_NEIGHBOR: "retained" # neighbor comment')
    expect(text).toContain('# grant comment')
    for (const reader of [context, await boot(path)]) {
      expect(await reader.credentials.readRecord(account)).toEqual({
        kind: 'grant', payload: { DSH_ALIAS_KEY: 'synthetic', DSH_ALIAS_NEIGHBOR: 'retained' },
      })
      expect(await reader.credentials.resolve(ref)).toEqual(operation === 'set'
        ? { value: 'replacement', source: 'file' } : undefined)
    }
  })

  it.each(['set', 'unset'])('%s preserves aliases of the edited scalar and unrelated anchors', async (operation) => {
    const path = await seed('version: 1\nrefs:\n  DSH_ALIAS_KEY: &changed synthetic\n'
      + '  DSH_ALIAS_NEIGHBOR: *changed # neighbor comment\n'
      + '  DSH_UNRELATED: &unrelated "unchanged" # unrelated comment\n'
      + 'records:\n  llm-provider/account:\n    kind: grant\n'
      + '    payload: {old: *changed, retained: *unrelated}\n')
    const context = await boot(path)

    if (operation === 'set') await context.credentials.set(ref, 'replacement')
    else await context.credentials.unset(ref)

    const text = await readFile(path, 'utf8')
    expect(text).toContain('DSH_UNRELATED: &unrelated "unchanged" # unrelated comment')
    expect(text).toContain('retained: *unrelated')
    expect(text).toContain('# neighbor comment')
    for (const reader of [context, await boot(path)]) {
      expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'synthetic', source: 'file' })
      expect(await reader.credentials.readRecord(account)).toEqual({ kind: 'grant', payload: { old: 'synthetic', retained: 'unchanged' } })
    }
  })

  it.each(['replace', 'delete'])('%s preserves aliases of an entire record and its nested anchors', async (operation) => {
    const path = await seed('version: 1\nrecords:\n  llm-provider/account: &record\n'
      + '    kind: grant\n    payload: {token: &token synthetic}\n'
      + '  llm-provider/other: *record # neighboring record\n'
      + 'refs:\n  DSH_ALIAS_KEY: *token # reference comment\n')
    const context = await boot(path)

    if (operation === 'replace') await context.credentials.modifyRecord(account, () => Promise.resolve({ kind: 'grant', payload: 'replacement' }))
    else await context.credentials.deleteRecord(account)

    const text = await readFile(path, 'utf8')
    expect(text).toContain('# neighboring record')
    expect(text).toContain('# reference comment')
    for (const reader of [context, await boot(path)]) {
      expect(await reader.credentials.readRecord(other)).toEqual({ kind: 'grant', payload: { token: 'synthetic' } })
      expect(await reader.credentials.resolve(ref)).toEqual({ value: 'synthetic', source: 'file' })
      expect(await reader.credentials.readRecord(account)).toEqual(operation === 'replace'
        ? { kind: 'grant', payload: 'replacement' } : undefined)
    }
  })

  it('edits aliased section and entry keys without duplicating their resolved identities', async () => {
    const path = await seed('version: 1\nrecords:\n  llm-provider/account:\n    kind: grant\n'
      + '    payload: {section: &section refs, name: &name DSH_ALIAS_KEY, token: &token synthetic}\n'
      + '*section :\n  *name : *token\n')
    const context = await boot(path)

    await context.credentials.set(ref, 'replacement')

    const text = await readFile(path, 'utf8')
    expect(parseCredentialsDocument(text, path).refs).toEqual(new Map([[ref, 'replacement']]))
    expect(text).toContain('payload: { section: &section refs, name: &name DSH_ALIAS_KEY, token: &token synthetic }')
    const reader = await boot(path)
    expect(await reader.credentials.resolve(ref)).toEqual({ value: 'replacement', source: 'file' })
    await reader.credentials.unset(ref)
    expect(await (await boot(path)).credentials.resolve(ref)).toBeUndefined()
  })

  it('keeps duplicate anchor names bound to their original preceding definitions', async () => {
    const path = await seed('version: 1\nrefs:\n  DSH_ALIAS_KEY: &shared first\n'
      + '  DSH_ALIAS_NEIGHBOR: *shared\n  DSH_LATER: &shared second\n'
      + 'records:\n  llm-provider/account:\n    kind: grant\n    payload: *shared\n')
    const context = await boot(path)

    await context.credentials.unset(ref)

    const reader = await boot(path)
    expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'first', source: 'file' })
    expect(await reader.credentials.readRecord(account)).toEqual({ kind: 'grant', payload: 'second' })
    expect(await readFile(path, 'utf8')).toContain('payload: *shared')
  })

  it('preserves a chain of shared grant collections when its referenced scalar changes', async () => {
    const path = await seed('version: 1\nrefs:\n  DSH_ALIAS_KEY: &token synthetic\n'
      + 'records:\n  llm-provider/account:\n    kind: grant\n'
      + '    payload: &payload {token: *token} # shared payload\n'
      + '  llm-provider/other:\n    kind: grant\n    payload: {nested: *payload}\n')
    const context = await boot(path)

    await context.credentials.set(ref, 'replacement')

    const reader = await boot(path)
    expect(await reader.credentials.readRecord(account)).toEqual({ kind: 'grant', payload: { token: 'synthetic' } })
    expect(await reader.credentials.readRecord(other)).toEqual({ kind: 'grant', payload: { nested: { token: 'synthetic' } } })
    const text = await readFile(path, 'utf8')
    expect(text).toContain('# shared payload')
    expect(text).toContain('payload: { nested: *payload }')
  })

  it('preserves alias keys and the version value when deleting their anchor-owning record', async () => {
    const path = await seed('records:\n  llm-provider/account:\n    kind: grant\n'
      + '    payload: {section: &section refs, name: &name DSH_ALIAS_KEY, version: &version 1}\n'
      + 'version: *version\n*section :\n  *name : synthetic\n')
    const context = await boot(path)

    await context.credentials.deleteRecord(account)

    const reader = await boot(path)
    expect(await reader.credentials.readRecord(account)).toBeUndefined()
    expect(await reader.credentials.resolve(ref)).toEqual({ value: 'synthetic', source: 'file' })
    expect(parseCredentialsDocument(await readFile(path, 'utf8'), path).refs).toEqual(new Map([[ref, 'synthetic']]))
  })

  it('adds a record to an anchored records section without changing its existing grant', async () => {
    const path = await seed('version: 1\nrecords: &records\n'
      + '  llm-provider/account:\n    kind: grant\n    payload: {token: synthetic}\n'
      + 'refs: {}\n')
    const context = await boot(path)
    await context.credentials.modifyRecord(other, () => Promise.resolve({ kind: 'grant', payload: 'neighbor' }))
    const reader = await boot(path)
    expect(await reader.credentials.readRecord(account)).toEqual({ kind: 'grant', payload: { token: 'synthetic' } })
    expect(await reader.credentials.readRecord(other)).toEqual({ kind: 'grant', payload: 'neighbor' })
  })

  it('replaces an anchored null section without changing a grant alias of that null', async () => {
    const path = await seed('version: 1\nrefs: &empty null # refs annotation\nrecords:\n'
      + '  llm-provider/account:\n    kind: grant\n    payload: *empty\n')
    const context = await boot(path)

    await context.credentials.set(ref, 'replacement')

    const reader = await boot(path)
    expect(await reader.credentials.resolve(ref)).toEqual({ value: 'replacement', source: 'file' })
    expect(await reader.credentials.readRecord(account)).toEqual({ kind: 'grant', payload: null })
    expect(await readFile(path, 'utf8')).toContain('# refs annotation')
  })

  it('writes a credential into a null document admitted as an empty store', async () => {
    const path = await seed('null # store annotation\n')
    const context = await boot(path)

    await context.credentials.set(ref, 'replacement')

    expect(await (await boot(path)).credentials.resolve(ref)).toEqual({ value: 'replacement', source: 'file' })
    expect(await readFile(path, 'utf8')).toContain('# store annotation')
  })

  it.each([
    { yaml: 'true', key: 'true' },
    { yaml: 'false', key: 'false' },
    { yaml: '.nan', key: 'NaN' },
    { yaml: '.inf', key: 'Infinity' },
  ])('edits the admitted scalar key $yaml by its resolved credential name', async ({ yaml, key }) => {
    const path = await seed(`version: 1\nrefs:\n  ${yaml}: synthetic\n`)
    const context = await boot(path)
    const scalarRef = credentialRef(key)
    expect(await context.credentials.resolve(scalarRef)).toEqual({ value: 'synthetic', source: 'file' })

    await context.credentials.set(scalarRef, 'replacement')

    const reader = await boot(path)
    expect(await reader.credentials.resolve(scalarRef)).toEqual({ value: 'replacement', source: 'file' })
    await reader.credentials.unset(scalarRef)
    expect(parseCredentialsDocument(await readFile(path, 'utf8'), path).refs.size).toBe(0)
    expect(await (await boot(path)).credentials.resolve(scalarRef)).toBeUndefined()
  })

  it('preserves the stored bytes and cached values when an external alias becomes unresolved', async () => {
    const path = await seed('version: 1\nrefs:\n  DSH_ALIAS_KEY: synthetic\n')
    const context = await boot(path)
    const malformed = 'version: 1\nrefs:\n  DSH_ALIAS_KEY: *missing\n'
    await writeFile(path, malformed, { mode: 0o600 })

    await expect(context.credentials.set(ref, 'replacement')).rejects.toThrow(/Unresolved alias/)

    expect(await readFile(path, 'utf8')).toBe(malformed)
    expect(await context.credentials.resolve(ref)).toEqual({ value: 'synthetic', source: 'file' })
  })

  it.each([false, true])('removes a merge-inherited reference including an explicit override: %s', async (override) => {
    const source = '    payload: &shared { DSH_ALIAS_KEY: synthetic, DSH_ALIAS_NEIGHBOR: "retained" } # grant comment\n'
    const path = await seed('%YAML 1.1\n---\nversion: 1\nrecords:\n  llm-provider/account:\n    kind: grant\n'
      + source + 'refs:\n  <<: *shared # merge comment\n'
      + (override ? '  DSH_ALIAS_KEY: explicit\n' : '')
      + '  DSH_LOCAL: "local value" # local comment\n')
    const context = await boot(path)
    expect(await context.credentials.resolve(ref)).toEqual({ value: override ? 'explicit' : 'synthetic', source: 'file' })

    await context.credentials.unset(ref)

    const text = await readFile(path, 'utf8')
    expect(text).toContain(source)
    expect(text).toContain('# merge comment')
    expect(text).toContain('DSH_LOCAL: "local value" # local comment')
    for (const reader of [context, await boot(path)]) {
      expect(await reader.credentials.resolve(ref)).toBeUndefined()
      expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'retained', source: 'file' })
      expect(await reader.credentials.readRecord(account)).toEqual({
        kind: 'grant', payload: { DSH_ALIAS_KEY: 'synthetic', DSH_ALIAS_NEIGHBOR: 'retained' },
      })
    }
  })

  it('removes a merged record while preserving merge precedence and inline source anchors', async () => {
    const path = await seed('%YAML 1.1\n---\nversion: 1\nrecords:\n  <<:\n'
      + '    - llm-provider/account: {kind: grant, payload: &token synthetic}\n'
      + '      llm-provider/other: {kind: grant, payload: "first"} # neighbor comment\n'
      + '    - llm-provider/account: {kind: grant, payload: later}\n'
      + '      llm-provider/other: {kind: grant, payload: second}\n'
      + 'refs:\n  DSH_ALIAS_KEY: *token # reference comment\n')
    const context = await boot(path)
    expect(await context.credentials.readRecord(other)).toEqual({ kind: 'grant', payload: 'first' })

    await context.credentials.deleteRecord(account)

    for (const reader of [context, await boot(path)]) {
      expect(await reader.credentials.readRecord(account)).toBeUndefined()
      expect(await reader.credentials.readRecord(other)).toEqual({ kind: 'grant', payload: 'first' })
      expect(await reader.credentials.resolve(ref)).toEqual({ value: 'synthetic', source: 'file' })
    }
    const text = await readFile(path, 'utf8')
    expect(text).toContain('# neighbor comment')
    expect(text).toContain('# reference comment')
    expect(text).toContain('"first"')
  })

  it('removes a reference from nested inline merges while preserving external aliases of the inner map', async () => {
    const path = await seed('%YAML 1.1\n---\nversion: 1\nrefs:\n  <<:\n'
      + '    <<: &inner {DSH_ALIAS_KEY: synthetic, DSH_ALIAS_NEIGHBOR: "retained"}\n'
      + '    DSH_LOCAL: "local value" # local comment\n'
      + 'records:\n  llm-provider/account:\n    kind: grant\n    payload: *inner\n')
    const context = await boot(path)

    await context.credentials.unset(ref)

    const reader = await boot(path)
    expect(await reader.credentials.resolve(ref)).toBeUndefined()
    expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'retained', source: 'file' })
    expect(await reader.credentials.readRecord(account)).toEqual({
      kind: 'grant', payload: { DSH_ALIAS_KEY: 'synthetic', DSH_ALIAS_NEIGHBOR: 'retained' },
    })
    const text = await readFile(path, 'utf8')
    expect(text).toContain('DSH_ALIAS_NEIGHBOR: "retained"')
    expect(text).toContain('DSH_LOCAL: "local value" # local comment')
  })

  it('removes a reference inherited through an aliased merge sequence without editing its grant source', async () => {
    const path = await seed('%YAML 1.1\n---\nversion: 1\nrecords:\n  llm-provider/account:\n'
      + '    kind: grant\n    payload: &sources\n'
      + '      - {DSH_ALIAS_KEY: first, DSH_ALIAS_NEIGHBOR: retained}\n'
      + '      - {DSH_ALIAS_KEY: second}\nrefs:\n  <<: *sources # merge sequence\n')
    const context = await boot(path)
    expect(await context.credentials.resolve(ref)).toEqual({ value: 'first', source: 'file' })

    await context.credentials.unset(ref)

    for (const reader of [context, await boot(path)]) {
      expect(await reader.credentials.resolve(ref)).toBeUndefined()
      expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'retained', source: 'file' })
      expect(await reader.credentials.readRecord(account)).toEqual({
        kind: 'grant', payload: [
          { DSH_ALIAS_KEY: 'first', DSH_ALIAS_NEIGHBOR: 'retained' },
          { DSH_ALIAS_KEY: 'second' },
        ],
      })
    }
    expect(await readFile(path, 'utf8')).toContain('# merge sequence')
  })

  it('edits references supplied by a root merge without dropping neighboring values', async () => {
    const path = await seed('%YAML 1.1\n---\n<<:\n  version: 1\n  refs:\n'
      + '    DSH_ALIAS_KEY: synthetic\n    DSH_ALIAS_NEIGHBOR: "retained" # neighbor comment\n')
    const context = await boot(path)

    await context.credentials.set(ref, 'replacement')

    const reader = await boot(path)
    expect(await reader.credentials.resolve(ref)).toEqual({ value: 'replacement', source: 'file' })
    expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'retained', source: 'file' })
    await reader.credentials.unset(ref)
    const restarted = await boot(path)
    expect(await restarted.credentials.resolve(ref)).toBeUndefined()
    expect(await restarted.credentials.resolve(neighbor)).toEqual({ value: 'retained', source: 'file' })
    expect(await readFile(path, 'utf8')).toContain('DSH_ALIAS_NEIGHBOR: "retained" # neighbor comment')
    expect(await readFile(path, 'utf8')).not.toContain('synthetic')
    expect(await readFile(path, 'utf8')).not.toContain('replacement')
  })

  it('deletes a record supplied by a root merge without dropping its neighboring record', async () => {
    const path = await seed('%YAML 1.1\n---\n<<:\n  version: 1\n  records:\n'
      + '    llm-provider/account: {kind: grant, payload: synthetic}\n'
      + '    llm-provider/other: {kind: grant, payload: "retained"} # neighbor comment\n')
    const context = await boot(path)

    await context.credentials.deleteRecord(account)

    const reader = await boot(path)
    expect(await reader.credentials.readRecord(account)).toBeUndefined()
    expect(await reader.credentials.readRecord(other)).toEqual({ kind: 'grant', payload: 'retained' })
    expect(await readFile(path, 'utf8')).toContain('llm-provider/other: { kind: grant, payload: "retained" } # neighbor comment')
    expect(await readFile(path, 'utf8')).not.toContain('synthetic')
  })

  it('preserves a root merge source that remains the payload of another live credential', async () => {
    const source = '    payload: &shared\n      refs: { DSH_ALIAS_KEY: synthetic, DSH_ALIAS_NEIGHBOR: "retained" } # grant comment\n'
    const path = await seed('%YAML 1.1\n---\nversion: 1\nrecords:\n  llm-provider/account:\n    kind: grant\n'
      + source + '<<: *shared\n')
    const context = await boot(path)

    await context.credentials.unset(ref)

    const reader = await boot(path)
    expect(await reader.credentials.resolve(ref)).toBeUndefined()
    expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'retained', source: 'file' })
    expect(await reader.credentials.readRecord(account)).toEqual({
      kind: 'grant', payload: { refs: { DSH_ALIAS_KEY: 'synthetic', DSH_ALIAS_NEIGHBOR: 'retained' } },
    })
    const text = await readFile(path, 'utf8')
    expect(text).toContain(source)
    expect(text.match(/synthetic/g)).toHaveLength(1)
  })

  it('removes obsolete root-merge contributors while preserving the winning section presentation', async () => {
    const path = await seed('%YAML 1.1\n---\nversion: 1\n<<:\n'
      + '  - refs: {DSH_ALIAS_KEY: first-value, DSH_ALIAS_NEIGHBOR: "retained"}\n'
      + '  - refs: {DSH_ALIAS_KEY: older-value, DSH_ALIAS_NEIGHBOR: older-neighbor}\n')
    const context = await boot(path)
    expect(await context.credentials.resolve(ref)).toEqual({ value: 'first-value', source: 'file' })

    await context.credentials.unset(ref)

    const reader = await boot(path)
    expect(await reader.credentials.resolve(ref)).toBeUndefined()
    expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'retained', source: 'file' })
    const text = await readFile(path, 'utf8')
    expect(text).toContain('DSH_ALIAS_NEIGHBOR: "retained"')
    expect(text).not.toContain('first-value')
    expect(text).not.toContain('older-value')
    expect(text).not.toContain('older-neighbor')
  })

  it('retains original alias bindings when a promoted section moves past a reused anchor name', async () => {
    const path = await seed('%YAML 1.1\n---\nrecords:\n  llm-provider/account:\n'
      + '    kind: grant\n    payload: &shared synthetic\n'
      + '<<:\n  refs: {DSH_ALIAS_KEY: *shared, DSH_ALIAS_NEIGHBOR: retained}\n'
      + 'version: &shared 1\n')
    const context = await boot(path)

    await context.credentials.set(neighbor, 'replacement')

    const reader = await boot(path)
    expect(await reader.credentials.resolve(ref)).toEqual({ value: 'synthetic', source: 'file' })
    expect(await reader.credentials.resolve(neighbor)).toEqual({ value: 'replacement', source: 'file' })
    expect(await reader.credentials.readRecord(account)).toEqual({ kind: 'grant', payload: 'synthetic' })
  })
})
