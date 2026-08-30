// Debug probe for session 3cc0f5 (dangling dsh-tools profile link).
// Replicates packageDirFromAnchor's resolution walk from the three anchors the
// healer uses, plus records the shared fallback link's current target and
// mtime. Read-only.
import { createRequire } from 'node:module'
import { existsSync, lstatSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = '/Users/brandon/Downloads/deepseek-harness/debug-3cc0f5-resolve-out.txt'
const rows: string[] = []
const pkg = '@deepseek-ai/dsh-tools'
const anchors = [
  '/Users/brandon/Downloads/deepseek-harness/apps/cli/package.json',
  '/Users/brandon/Downloads/deepseek-harness/apps/cli/node_modules/@deepseek-ai/dsh-agent-tool-presentation/package.json',
  '/Users/brandon/.dsh/profiles/web/package.json',
]
for (const anchor of anchors) {
  const searchPaths = createRequire(anchor).resolve.paths(pkg) ?? []
  rows.push(`anchor ${anchor}`)
  for (const searchPath of searchPaths.slice(0, 10)) {
    const candidate = join(searchPath, pkg)
    const alive = existsSync(join(candidate, 'package.json'))
    let detail = 'dead'
    if (alive) detail = `alive -> ${realpathSync(candidate)}`
    rows.push(`  ${candidate} ${detail}`)
  }
}
const fallback = join('/Users/brandon/.dsh/profiles/node_modules', '@deepseek-ai', 'dsh-tools')
rows.push(`fallback readlink: ${readlinkSync(fallback)}`)
const stat = lstatSync(fallback)
rows.push(`fallback mtime: ${stat.mtime.toISOString()}`)
writeFileSync(out, rows.join('\n') + '\n')
