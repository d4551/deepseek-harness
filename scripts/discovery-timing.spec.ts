/**
 * When browser-lane discovery parses. Every config load runs it over every
 * client spec, and the Babel parse is its only real cost, so a spec earns a
 * parse only by spelling the accessibility harness's specifier. This pins
 * that timing with files that are not parseable at all: a quiet one must
 * pass through on a single read, a loud one must fail in the parser.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { discoverClientBrowserTests } from '../vitest.client-browser.ts'

it('parses a client spec only when it names the harness, so discovery never pays for the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-discovery-timing-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const tests = join(root, 'packages/client/surface/tests')
  await mkdir(tests, { recursive: true })
  // Unparseable, but silent on the harness: discovery must not open the parser on it.
  await writeFile(join(tests, 'broken-quiet.client.spec.ts'), 'export const = \n')
  await writeFile(join(tests, 'plain.client.spec.ts'), "import { render } from '@deepseek-ai/dsh-client-test-runtime'\nrender\n")
  expect(discoverClientBrowserTests(root)).toEqual([])
  // Unparseable and naming the harness: the parse that decides the lane fails loud.
  await writeFile(join(tests, 'broken-loud.client.spec.ts'), "import { x } from '@deepseek-ai/dsh-client-a11y'\nexport const = \n")
  expect(() => discoverClientBrowserTests(root)).toThrow(/Unexpected token/)
})
