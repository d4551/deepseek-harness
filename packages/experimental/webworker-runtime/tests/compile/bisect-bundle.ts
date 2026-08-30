/** Scratch: bisect a bundle for the first line range Node's ESM parser rejects. */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const target = process.argv[2]
if (target === undefined) throw new Error('usage: bisect-bundle.ts <bundle>')
const lines = readFileSync(target, 'utf8').split('\n')
const probe = target.replace(/\.js$/, '.bisect-probe.mjs')

function parses(upto: number): Promise<boolean> {
  writeFileSync(probe, lines.slice(0, upto).join('\n'))
  return import(`${pathToFileURL(probe).href}?n=${String(upto)}`).then(
    () => true,
    (reason: unknown) => (reason as Error).name !== 'SyntaxError',
  )
}

let lo = 0
let hi = lines.length
while (lo < hi) {
  const mid = Math.floor((lo + hi + 1) / 2)
  if (await parses(mid)) lo = mid
  else hi = mid - 1
}
unlinkSync(probe)
process.stdout.write(`total=${String(lines.length)} firstBadLine=${String(lo + 1)}\n`)
process.stdout.write(`line: ${JSON.stringify(lines[lo]?.slice(0, 300) ?? '')}\n`)
process.stdout.write(`prev: ${JSON.stringify(lines[lo - 1]?.slice(0, 300) ?? '')}\n`)
