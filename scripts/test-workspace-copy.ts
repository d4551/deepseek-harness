import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Copy current repository files into an independent executable test workspace.
 * @param sourceRoot - Repository whose sources and configurations are exercised.
 * @param root - Owned directory whose cleanup is already registered by the suite.
 */
export async function populateTestWorkspace(sourceRoot: string, root: string): Promise<void> {
  const options = { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 } satisfies Parameters<typeof execFileSync>[2]
  const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], options)
  const deleted = new Set(execFileSync('git', ['ls-files', '--deleted', '-z'], options).split('\0'))
  const paths = [...new Set(listing.split('\0'))]
  for (let offset = 0; offset < paths.length; offset += 32) {
    const results = await Promise.allSettled(paths.slice(offset, offset + 32).map(async (path) => {
      if (path.length === 0 || deleted.has(path)) return
      const destination = join(root, path)
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(sourceRoot, path), destination, { verbatimSymlinks: true })
    }))
    const errors = results.flatMap(result => result.status === 'rejected' ? [new Error('File copy failed', { cause: result.reason })] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Could not populate test workspace')
  }
  for (const directory of new Set(paths.map(path => dirname(path)))) {
    const dependencies = join(sourceRoot, directory, 'node_modules')
    if (existsSync(dependencies)) {
      await symlink(dependencies, join(root, directory, 'node_modules'), 'junction')
    }
  }
  execFileSync('git', ['init', '--quiet', root], { encoding: 'utf8' })
}
