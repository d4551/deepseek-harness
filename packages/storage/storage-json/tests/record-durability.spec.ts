import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

it.each(['create', 'delete'])('flushes actual record %s publication before returning', async (operation) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-record-durability-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const root = join(directory, 'parent', 'data')
  const tracePath = join(directory, 'trace.json')
  const output = execFileSync(process.execPath, [
    '--import', 'tsx', `--trace-event-file-pattern=${tracePath}`,
    fileURLToPath(new URL('./record-durability-trace.mjs', import.meta.url)), root, operation,
  ], { encoding: 'utf8', timeout: 20_000 })
  expect(output).toBe('')
  const record = join(root, 'records', 'items', 'saved.json')
  expect(JSON.parse(await readFile(record, 'utf8'))).toEqual(operation === 'create'
    ? { version: 1, record: true }
    : { version: 1, deleted: true })

  const trace: unknown = JSON.parse(await readFile(tracePath, 'utf8'))
  assert.ok(typeof trace === 'object' && trace !== null && 'traceEvents' in trace && Array.isArray(trace.traceEvents))
  const events: unknown[] = trace.traceEvents
  const operations = events.flatMap((event) => {
    assert.ok(typeof event === 'object' && event !== null && 'cat' in event && typeof event.cat === 'string')
    if (!event.cat.split(',').includes('node.fs.async')) return []
    assert.ok('name' in event && typeof event.name === 'string' && 'ph' in event && typeof event.ph === 'string'
      && 'id' in event && typeof event.id === 'string' && 'args' in event && typeof event.args === 'object' && event.args !== null
      && 'pid' in event && typeof event.pid === 'number' && 'tid' in event && typeof event.tid === 'number')
    return [{ name: event.name, phase: event.ph, id: event.id, args: event.args, pid: event.pid, tid: event.tid }]
  })
  const syncs = operations.filter(event => event.name === 'fsync' && event.phase === 'b')
  expect(syncs.length).toBeGreaterThan(0)
  for (const sync of syncs) {
    const beginIndex = operations.indexOf(sync)
    expect(operations.find((event, index) => index > beginIndex && event.pid === sync.pid && event.tid === sync.tid
      && event.id === sync.id && event.name === 'fsync' && event.phase === 'e')?.args)
      .toEqual({ result: 0 })
  }
  if (process.platform !== 'win32') {
    const required = new Set([dirname(record)])
    if (operation === 'create') {
      let ancestor = dirname(record)
      const boundary = parse(ancestor).root
      while (ancestor !== boundary) {
        ancestor = dirname(ancestor)
        required.add(ancestor)
      }
    }
    const starts = operations.filter(event => event.phase === 'b')
    for (const path of required) {
      const index = starts.findIndex(event => event.name === 'open'
        && 'path' in event.args && event.args.path === path)
      expect(index, `directory ${path} must be opened for sync`).toBeGreaterThanOrEqual(0)
      const sequence = starts.slice(index, index + 3)
      expect(sequence.map(event => event.name), JSON.stringify(sequence)).toEqual(['open', 'fsync', 'close'])
      for (const start of sequence) {
        const beginIndex = operations.indexOf(start)
        const endIndex = operations.findIndex((event, position) => position > beginIndex
          && event.pid === start.pid && event.tid === start.tid
          && event.phase === 'e' && event.id === start.id && event.name === start.name)
        expect(endIndex).toBeGreaterThan(beginIndex)
        const end = operations[endIndex]
        assert.ok(end !== undefined && 'result' in end.args && typeof end.args.result === 'number')
        expect(end.args.result).toBeGreaterThanOrEqual(0)
        const next = starts[starts.indexOf(start) + 1]
        if (next !== undefined) expect(endIndex).toBeLessThan(operations.indexOf(next))
      }
    }
  }
})
