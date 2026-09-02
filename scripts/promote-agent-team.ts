/**
 * One-shot promotion of the Agent Teams packages from packages/experimental
 * to their product-role groups. Rewrites npm names and repository paths in
 * every tracked file that references them, excluding node_modules. Historical
 * Agent Notes and goal plans are not in the root set; they record their own
 * time. Run once, then delete.
 */
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const replacements: ReadonlyArray<readonly [string, string]> = [
  ['@deepseek-ai/dsh-agent-team-web-profile', '@deepseek-ai/dsh-agent-team-web-profile'],
  ['@deepseek-ai/dsh-agent-team-profile', '@deepseek-ai/dsh-agent-team-profile'],
  ['@deepseek-ai/dsh-client-ui-agent-team', '@deepseek-ai/dsh-client-ui-agent-team'],
  ['@deepseek-ai/dsh-tool-agent-team', '@deepseek-ai/dsh-tool-agent-team'],
  ['@deepseek-ai/dsh-agent-team', '@deepseek-ai/dsh-agent-team'],
  ['packages/preset/agent-team-web-profile', 'packages/preset/agent-team-web-profile'],
  ['packages/preset/agent-team-profile', 'packages/preset/agent-team-profile'],
  ['packages/client/ui-agent-team', 'packages/client/ui-agent-team'],
  ['packages/subagent/tool-agent-team', 'packages/subagent/tool-agent-team'],
  ['packages/subagent/agent-team', 'packages/subagent/agent-team'],
]

const roots = [
  'packages/subagent/agent-team',
  'packages/subagent/tool-agent-team',
  'packages/client/ui-agent-team',
  'packages/preset/agent-team-profile',
  'packages/preset/agent-team-web-profile',
  'packages/experimental',
  'apps',
  'scripts',
  'docs',
  'tsconfig.base.json',
  'tsconfig.host.json',
  'tsconfig.client.json',
]

const skipDirs = new Set(['node_modules', '.git'])

function * walk (path: string): Generator<string> {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (skipDirs.has(entry)) continue
      yield * walk(join(path, entry))
    }
    return
  }
  if (stat.isFile()) yield path
}

const changed: string[] = []
for (const root of roots) {
  for (const file of walk(root)) {
    const before = readFileSync(file, 'utf8')
    let after = before
    for (const [from, to] of replacements) after = after.split(from).join(to)
    if (after !== before) {
      writeFileSync(file, after)
      changed.push(file)
    }
  }
}
process.stdout.write(`${changed.length} files updated\n${changed.join('\n')}\n`)
