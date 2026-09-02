/**
 * Canonical directory-boundary checks for the Windows ACL workspace and
 * private-temp capabilities.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/path-boundary
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

/** Whether `root` is the same canonical directory as `candidate` or contains it. */
function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate))
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * Reject a temp parent that is inside ANY workspace root: every child created
 * below it would inherit that root's standing workspace capability.
 * @param workspaceRoots - the canonical workspace roots that receive the standing ACEs.
 * @param tempRoot - the existing parent beneath which a private temp child would be created.
 */
export function assertTempRootOutsideWorkspace(workspaceRoots: readonly string[], tempRoot: string): void {
  for (const workspaceRoot of workspaceRoots) {
    if (containsDirectory(workspaceRoot, tempRoot)) {
      throw new Error(`Windows ACL temp root must be outside the workspace: workspace=${workspaceRoot}; temp=${tempRoot}`)
    }
  }
}

/**
 * Reject overlap between an actual private temp directory and any writable
 * directory: either inheritance direction would merge the two capabilities.
 * @param writableDirs - directories carrying the standing workspace capability.
 * @param tempDir - the existing directory carrying the revocable temp capability.
 */
export function assertPrivateTempDisjoint(writableDirs: readonly string[], tempDir: string): void {
  for (const writableDir of writableDirs) {
    if (containsDirectory(writableDir, tempDir) || containsDirectory(tempDir, writableDir)) {
      throw new Error(`AclSandbox private temp directory must be disjoint from writable directories: writable=${writableDir}; temp=${tempDir}`)
    }
  }
}
