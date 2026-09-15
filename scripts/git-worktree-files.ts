import { execFileSync } from 'node:child_process'

/** Files present in the worktree and tracked paths explicitly removed from it. */
export interface GitWorktreeFiles {
  /** Current tracked and untracked source paths. */
  files: string[]
  /** Tracked paths with unstaged deletions. */
  deleted: string[]
}

/**
 * Inventory current source without requiring a commit or index mutation.
 * @param root - Repository whose worktree is inspected.
 * @param pathspecs - Git pathspecs selecting the caller's source language.
 * @returns Existing source paths and explicitly deleted tracked paths.
 */
export function gitWorktreeFiles(root: string, pathspecs: readonly string[] = []): GitWorktreeFiles {
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 } satisfies Parameters<typeof execFileSync>[2]
  const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...pathspecs], options)
  const removed = execFileSync('git', ['ls-files', '--deleted', '-z', '--', ...pathspecs], options)
  const deleted = new Set(removed.split('\0').filter(path => path.length > 0))
  const files = [...new Set(listing.split('\0'))].filter(path => path.length > 0 && !deleted.has(path))
  return { files, deleted: [...deleted] }
}
