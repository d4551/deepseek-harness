import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { discoverClientBrowserTests } from '../vitest.client-browser.ts'

it('discovers every browser test file without reading similarly named directories as source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-discovery-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const tests = join(root, 'packages/client/surface/tests')
  const artifact = join(tests, '__screenshots__/surface.client.spec.tsx')
  await mkdir(artifact, { recursive: true })
  await writeFile(join(tests, 'menu.browser.spec.tsx'), 'export const menu = true\n')
  await writeFile(join(tests, 'a11y.client.spec.tsx'), "import { auditSurface } from '@deepseek-ai/dsh-client-a11y'\n")
  await symlink(join(tests, 'menu.browser.spec.tsx'), join(tests, 'linked.browser.spec.tsx'), 'file')
  await symlink(join(tests, 'a11y.client.spec.tsx'), join(tests, 'linked-a11y.client.spec.tsx'), 'file')
  await writeFile(join(artifact, 'nested.browser.spec.tsx'), 'export const nested = true\n')
  await writeFile(join(artifact, 'failure.png'), new Uint8Array([137, 80, 78, 71]))
  expect(discoverClientBrowserTests(root)).toEqual([
    'packages/client/surface/tests/__screenshots__/surface.client.spec.tsx/nested.browser.spec.tsx',
    'packages/client/surface/tests/a11y.client.spec.tsx',
    'packages/client/surface/tests/linked-a11y.client.spec.tsx',
    'packages/client/surface/tests/linked.browser.spec.tsx',
    'packages/client/surface/tests/menu.browser.spec.tsx',
  ])
  await symlink(join(tests, 'missing.tsx'), join(tests, 'broken.browser.spec.tsx'), 'file')
  expect(() => discoverClientBrowserTests(root)).toThrow('ENOENT')
})
