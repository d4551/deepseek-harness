/** Scratch: compile a bundle body with V8 via vm.compileFunction and report the positioned syntax error. */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const target = process.argv[2]
if (target === undefined) throw new Error('usage: vm-compile.ts <bundle>')
const source = readFileSync(target, 'utf8')
// ESM-only lines (import/export) are stripped so the body can compile as a
// function; token-level errors survive the stripping because they keep their
// line offsets.
const body = source
  .split('\n')
  .map(line => (/^\s*(import|export)\b/.test(line) ? '' : line))
  .join('\n')
new vm.Script(body, { filename: target })
process.stdout.write('vm compile: clean\n')
