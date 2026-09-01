// Diagnostic: import every workspace tsdown.config.* the way tsdown loads them.
import { globSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { EOL } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname
const configs = globSync('packages/*/*/tsdown.config.{ts,js,mjs}', { cwd: root })
const lines: string[] = [`loaded ${String(configs.length)} configs`]
for (const relative of configs) {
  await import(pathToFileURL(`${root}${relative}`).href)
  lines.push(`ok ${relative}`)
}
await writeFile(`${root}tmp-probe-configs.out`, lines.join(EOL))
