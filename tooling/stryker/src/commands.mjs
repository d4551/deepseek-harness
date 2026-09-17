import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Retain complete stdout/stderr and require successful, fully reaped commands. */
export function run(work, name, command, args, cwd = work) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(join(work, `${name}.log`), output)
  process.stdout.write(output)
  assert.equal(result.error, undefined, `${name}: process startup failed`)
  assert.equal(result.signal, null, `${name}: process terminated by signal`)
  assert.equal(result.status, 0, `${name}: see ${join(work, `${name}.log`)}`)
  return output
}
