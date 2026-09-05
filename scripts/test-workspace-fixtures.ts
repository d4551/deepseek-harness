import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create isolated workspace directories and remove every directory this owner created.
 * @param prefix - prefix for each workspace root.
 * @returns workspace creation, JSON writing, and cleanup operations.
 */
export function createWorkspaceFixtures(prefix: string): {
  createRoot: () => string
  cleanup: () => void
  writeJson: (path: string, value: unknown) => void
} {
  const roots: string[] = []
  return {
    createRoot: () => {
      const root = mkdtempSync(join(tmpdir(), prefix))
      roots.push(root)
      return root
    },
    cleanup: () => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    },
    writeJson: (path, value) => {
      writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
    },
  }
}
