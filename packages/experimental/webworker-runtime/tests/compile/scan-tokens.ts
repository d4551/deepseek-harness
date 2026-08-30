/** Scratch: report lines of a bundle that Node's ESM parser commonly rejects. */
import { readFileSync } from 'node:fs'

const target = process.argv[2]
if (target === undefined) throw new Error('usage: scan-tokens.ts <bundle>')
const source = readFileSync(target, 'utf8')
source.split('\n').forEach((line, index) => {
  if (/[\u2028\u2029]|<!--/.test(line)) {
    process.stdout.write(`${String(index + 1)}: ${JSON.stringify(line.slice(0, 160))}\n`)
  }
})
process.stdout.write('scan done\n')
