import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitWorktreeFiles } from './git-worktree-files.ts'
import { typescriptImportViolationsForPaths } from './typescript-module-imports.ts'

it('audits new source through renames and still rejects a file lost after discovery', async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-source-inventory-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', root])
  await writeFile(join(root, 'kept.ts'), "import { version } from 'typescript'\n")
  await writeFile(join(root, 'removed.ts'), "import { version } from 'typescript'\n")
  execFileSync('git', ['add', '.'], { cwd: root })
  await rm(join(root, 'removed.ts'))
  const added = 'added source-猫.ts'
  await writeFile(join(root, added), "import compiler from 'typescript'\n")

  const inventory = gitWorktreeFiles(root, ['*.ts'])

  expect(inventory.files.sort()).toEqual([added, 'kept.ts'])
  expect(inventory.deleted).toEqual(['removed.ts'])
  expect(typescriptImportViolationsForPaths(root, inventory.files)).toEqual([{
    file: added, specifier: 'typescript', reason: "only { version, versionMajorMinor } may come from 'typescript'",
  }])
  await rm(join(root, added))
  expect(() => typescriptImportViolationsForPaths(root, inventory.files)).toThrow(/ENOENT/)
})
