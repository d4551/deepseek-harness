import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { populateTestWorkspace } from './test-workspace-copy.ts'

it('copies current source content and tracked deletions into an independent Git workspace', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lint-copy-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source')
  const target = join(directory, 'target')
  await mkdir(join(source, 'node_modules'), { recursive: true })
  await mkdir(target)
  await mkdir(join(source, 'packages', 'leaf', 'node_modules', 'dependency'), { recursive: true })
  await writeFile(join(source, 'packages', 'leaf', 'package.json'), JSON.stringify({ name: 'leaf', private: true }))
  await writeFile(join(source, 'packages', 'leaf', 'node_modules', 'dependency', 'index.js'), 'export const installed = true\n')
  execFileSync('git', ['init', '--quiet', source])
  await writeFile(join(source, '.gitignore'), 'node_modules/\n')
  await writeFile(join(source, 'edited.ts'), 'export const value = 1\n')
  await writeFile(join(source, 'removed.ts'), 'export const removed = true\n')
  execFileSync('git', ['add', '.'], { cwd: source })
  await writeFile(join(source, 'edited.ts'), 'export const value = 2\n')
  await rm(join(source, 'removed.ts'))
  await writeFile(join(source, 'new.ts'), 'export const added = true\n')
  await symlink('edited.ts', join(source, 'linked.ts'))

  await populateTestWorkspace(source, target)

  await expect(readFile(join(target, 'edited.ts'), 'utf8')).resolves.toBe('export const value = 2\n')
  await expect(readFile(join(target, 'new.ts'), 'utf8')).resolves.toBe('export const added = true\n')
  await expect(readlink(join(target, 'linked.ts'))).resolves.toBe('edited.ts')
  expect(existsSync(join(target, 'removed.ts'))).toBe(false)
  expect(existsSync(join(target, '.git'))).toBe(true)
  await expect(readFile(join(target, 'packages', 'leaf', 'node_modules', 'dependency', 'index.js'), 'utf8'))
    .resolves.toBe('export const installed = true\n')
  await writeFile(join(target, 'edited.ts'), 'export const value = 3\n')
  await expect(readFile(join(source, 'edited.ts'), 'utf8')).resolves.toBe('export const value = 2\n')
})


it('finishes the active copy batch before reporting a destination failure', async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-copy-failure-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'source')
  const target = join(directory, 'target')
  await mkdir(join(source, 'node_modules'), { recursive: true })
  await mkdir(join(source, 'blocked'))
  await mkdir(target)
  execFileSync('git', ['init', '--quiet', source])
  await writeFile(join(source, '.gitignore'), 'node_modules/\n')
  await writeFile(join(source, 'blocked', 'index.ts'), 'export const blocked = true\n')
  await writeFile(join(target, 'blocked'), 'occupied')
  const contents = 'export const copied = true\n'.repeat(100_000)
  await writeFile(join(source, 'completed.ts'), contents)

  await expect(populateTestWorkspace(source, target)).rejects.toThrow(AggregateError)

  await expect(readFile(join(target, 'completed.ts'), 'utf8')).resolves.toBe(contents)
  await expect(readFile(join(target, 'blocked'), 'utf8')).resolves.toBe('occupied')
})
