import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

it('completes native file and directory flushes when replacing a published unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-trace-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const target = join(root, 'unit.json')
  const tracePath = join(root, 'trace.json')

  // Core tracing observes native operations without replacing the filesystem.
  const output = execFileSync(process.execPath, [
    '--import', 'tsx',
    `--trace-event-file-pattern=${tracePath}`,
    fileURLToPath(new URL('./atomic-trace.mjs', import.meta.url)),
    target,
  ], { encoding: 'utf8', timeout: 10_000 })
  expect(output).toBe('')
  expect(await readFile(target, 'utf8')).toBe('durably published')
  expect((await readdir(root)).sort()).toEqual(['trace.json', 'unit.json'])

  const trace: unknown = JSON.parse(await readFile(tracePath, 'utf8'))
  assert.ok(typeof trace === 'object' && trace !== null
    && 'traceEvents' in trace && Array.isArray(trace.traceEvents))
  const events: unknown[] = trace.traceEvents
  const operations = events.flatMap((event) => {
    assert.ok(typeof event === 'object' && event !== null
      && 'cat' in event && typeof event.cat === 'string')
    if (!event.cat.split(',').includes('node.fs.async')) return []
    assert.ok('name' in event && typeof event.name === 'string'
      && 'ph' in event && typeof event.ph === 'string'
      && 'id' in event && typeof event.id === 'string'
      && 'args' in event && typeof event.args === 'object' && event.args !== null)
    return [{ name: event.name, ph: event.ph, id: event.id, args: event.args }]
  })
  const expected = ['open', 'write', 'fsync', 'close']
  if (process.platform !== 'win32') expected.push('rename', 'open', 'fsync', 'close')
  expect(operations.map(event => `${event.ph}:${event.name}`)).toEqual(
    expected.flatMap(name => [`b:${name}`, `e:${name}`]),
  )
  for (let index = 0; index < operations.length; index += 2) {
    const begin = operations[index]
    const end = operations[index + 1]
    assert.ok(begin !== undefined && end !== undefined)
    expect(end.id).toBe(begin.id)
    assert.ok('result' in end.args && typeof end.args.result === 'number')
    expect(end.args.result).toBeGreaterThanOrEqual(0)
  }
  const staging = operations[0]?.args
  assert.ok(staging !== undefined && 'path' in staging && typeof staging.path === 'string')
  expect(dirname(staging.path)).toBe(root)
  expect(staging.path).not.toBe(target)
  if (process.platform !== 'win32') {
    expect(operations[10]?.args).toMatchObject({ path: root })
  }
})
