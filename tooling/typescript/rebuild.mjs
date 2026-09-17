import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const owner = fileURLToPath(new URL('.', import.meta.url))
const mode = process.argv[2]
assert.ok(mode === 'check' || mode === 'rebuild', 'Usage: bun tooling/typescript/rebuild.mjs check|rebuild')
assert.equal(process.argv.length, 3)
const provenance = JSON.parse(await readFile(join(owner, 'provenance.json'), 'utf8'))
assert.equal(Bun.version, provenance.bun)
assert.equal(execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(), provenance.node)
const work = await mkdtemp(join(tmpdir(), 'dsh-typescript-build-'))
console.log(`TypeScript reconstruction: ${work}`)

for (const [name, input] of Object.entries(provenance.archives)) {
  const response = await fetch(input.url)
  assert.ok(response.ok, `${input.url}: HTTP ${response.status}`)
  const bytes = await response.bytes()
  const [algorithm, expected] = input.integrity.split('-')
  assert.equal(createHash(algorithm).update(bytes).digest('base64'), expected, `${name} integrity differs`)
  await new Bun.Archive(bytes).extract(join(work, name))
}

const source = join(work, 'source', `typescript-go-${provenance.gitHead}`)
const original = join(work, 'published/package')
const current = join(work, 'current')
const build = join(work, 'build')
await cp(join(owner, 'build'), build, { recursive: true })
execFileSync('bun', ['install', '--frozen-lockfile', '--cache-dir', join(work, 'cache')], { cwd: build, stdio: 'inherit' })
await symlink(join(build, 'node_modules'), join(source, 'node_modules'), 'dir')
execFileSync('git', ['apply', '--whitespace=error-all', join(owner, 'schema.patch')], { cwd: source, stdio: 'inherit' })
const env = { ...process.env, PATH: `${join(build, 'node_modules/.bin')}${delimiter}${process.env.PATH}` }
execFileSync('node', ['_scripts/generate-ts-ast.ts'], { cwd: source, env, stdio: 'inherit' })
execFileSync('node', [join(build, 'node_modules/typescript/bin/tsc'), '-b', '_packages/native-preview/tsconfig.json', '--force'], {
  cwd: source, stdio: 'inherit',
})
await cp(original, current, { recursive: true })
const generated = join(source, '_packages/native-preview/dist')
const inventory = {}
const originalFiles = (await readdir(join(original, 'dist'), { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(join(original, 'dist').length + 1)).sort()
const generatedFiles = (await readdir(generated, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(generated.length + 1)).sort()
assert.deepEqual(generatedFiles, originalFiles, 'The complete published API must be rebuilt')
for (const file of generatedFiles) {
  const bytes = await readFile(join(generated, file))
  if (file.endsWith('.js')) assert.deepEqual(bytes, await readFile(join(original, 'dist', file)), `${file} changes runtime behavior`)
  inventory[`dist/${file.replaceAll('\\', '/')}`] = createHash('sha256').update(bytes).digest('hex')
}
await cp(generated, join(current, 'dist'), { recursive: true })
await cp(original, join(work, 'original'), { recursive: true })
const diff = spawnSync('git', ['-c', 'diff.suppressBlankEmpty=true', 'diff', '--no-index', '--no-prefix', '--unified=2', 'original', 'current'], {
  cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
})
assert.equal(diff.error, undefined)
assert.equal(diff.signal, null)
assert.equal(diff.status, 1)
assert.equal(diff.stderr, '')
const patch = diff.stdout.split('\n').map(line => {
  if (line.startsWith('diff --git original/')) return line.replace('diff --git original/', 'diff --git a/').replace(' current/', ' b/')
  if (line.startsWith('--- original/')) return line.replace('--- original/', '--- a/')
  if (line.startsWith('+++ current/')) return line.replace('+++ current/', '+++ b/')
  return line
}).join('\n')
const artifacts = new Map([
  ['typescript@7.0.2.patch', Buffer.from(patch)],
  ['inventory.json', Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`)],
])
const destination = join(owner, 'artifacts')
if (mode === 'rebuild') {
  await mkdir(destination, { recursive: true })
  for (const [name, bytes] of artifacts) await writeFile(join(destination, name), bytes)
} else {
  assert.deepEqual((await readdir(destination)).sort(), [...artifacts.keys()].sort())
  for (const [name, bytes] of artifacts) assert.deepEqual(await readFile(join(destination, name)), bytes, `${name} differs`)
}
console.log(`TypeScript ${mode}: ${generatedFiles.length} files reproduced; all executable JavaScript matches upstream`)
