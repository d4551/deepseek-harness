// Debug probe for session 3cc0f5 (dangling dsh-tools profile link).
// Records the live resolution walk for @deepseek-ai/dsh-tools from both boot
// anchors, plus fallback link chain health. Read-only.
import { createRequire } from 'node:module'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const rows: string[] = []
const pkg = '@deepseek-ai/dsh-tools'
const anchors = [
  '/Users/brandon/Downloads/deepseek-harness/apps/cli/package.json',
  '/Users/brandon/.dsh/profiles/web/package.json',
]
for (const anchor of anchors) {
  const searchPaths = createRequire(anchor).resolve.paths(pkg) ?? []
  rows.push(`anchor ${anchor}`)
  for (const searchPath of searchPaths.slice(0, 14)) {
    const candidate = join(searchPath, pkg)
    const alive = existsSync(join(candidate, 'package.json'))
    rows.push(`  ${candidate} ${alive ? `alive -> ${realpathSync(candidate)}` : 'dead'}`)
    if (alive) break
  }
}
const chain = [
  '/Users/brandon/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tools',
  '/Users/brandon/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools',
  '/Users/brandon/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/package.json',
  '/Users/brandon/Downloads/deepseek-harness/apps/cli/node_modules/@deepseek-ai/dsh-tools/package.json',
  '/Users/brandon/Downloads/deepseek-harness/apps/cli/node_modules/@deepseek-ai/dsh-agent-tool-presentation/node_modules/@deepseek-ai/dsh-tools/package.json',
]
rows.push('chain:')
for (const item of chain) rows.push(`  existsSync(${item}) = ${existsSync(item)}`)
writeFileSync('/Users/brandon/Downloads/deepseek-harness/debug-3cc0f5-resolve-out.txt', rows.join('\n') + '\n')
