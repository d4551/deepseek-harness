import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { discoverClientBrowserTests } from '../vitest.client-browser.ts'

async function specTree(): Promise<{ root: string; tests: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-discovery-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const tests = join(root, 'packages/client/surface/tests')
  await mkdir(tests, { recursive: true })
  return { root, tests }
}

it('discovers every browser test file without reading similarly named directories as source', async () => {
  const { root, tests } = await specTree()
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

it('routes a client spec to the browser lane only for a value import of the harness', async () => {
  const { root, tests } = await specTree()
  await writeFile(join(tests, 'value.client.spec.ts'), "import { auditSurface } from '@deepseek-ai/dsh-client-a11y'\nauditSurface\n")
  await writeFile(join(tests, 'types.client.spec.ts'), "import type { Audit } from '@deepseek-ai/dsh-client-a11y'\nexport type T = Audit\n")
  await writeFile(join(tests, 'mention.client.spec.ts'), '// audited elsewhere with @deepseek-ai/dsh-client-a11y\nexport const plain = 1\n')
  await writeFile(join(tests, 'other.client.spec.ts'), "import { render } from '@deepseek-ai/dsh-client-test-runtime'\nrender\n")
  expect(discoverClientBrowserTests(root)).toEqual(['packages/client/surface/tests/value.client.spec.ts'])
})

it('reads JSX in a TSX spec and decorators in either, so syntax never hides a harness import', async () => {
  const { root, tests } = await specTree()
  await writeFile(join(tests, 'jsx.client.spec.tsx'), [
    "import { auditSurface } from '@deepseek-ai/dsh-client-a11y'",
    'export const surface = <main>{auditSurface}</main>',
    '',
  ].join('\n'))
  await writeFile(join(tests, 'decorated.client.spec.ts'), [
    "import { auditSurface } from '@deepseek-ai/dsh-client-a11y'",
    'function seal(target: object): object { return target }',
    '@seal class Probe { audit = auditSurface }',
    'export { Probe }',
    '',
  ].join('\n'))
  expect(discoverClientBrowserTests(root)).toEqual([
    'packages/client/surface/tests/decorated.client.spec.ts',
    'packages/client/surface/tests/jsx.client.spec.tsx',
  ])
})
