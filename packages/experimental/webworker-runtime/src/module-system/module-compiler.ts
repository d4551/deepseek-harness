/**
 * Compile image module bodies by importing generated `data:` modules, so the
 * worker host carries no `Function` constructor and no JavaScript parser for
 * bodies the packer already lowered.
 *
 * Each call emits one module — every body as a function over the
 * {@link MODULE_PARAMS} names plus a default array of those functions —
 * URL-encodes it, imports it through the runtime's own dynamic import, and
 * returns the functions as {@link ModuleBody} values the loader binds on
 * demand. `precompileImage` walks the whole image and produces one factory
 * per lowered body, keyed by its VFS path.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-compiler
 */
import { IMAGE_EMPTY_DIRECTORIES, MODULE_PARAMS } from '../image-layout.ts'
import type { MemoryVfs } from '../storage/memory.ts'
import type { ModuleBody } from './module-loader.ts'
import { join } from './posix-path.ts'

/** Root subtrees that hold data, never lowered code, so they never compile. */
const DATA_DIRECTORIES = new Set(IMAGE_EMPTY_DIRECTORIES.map(name => name.replace(/\/$/, '')))

/** Upper bound on bodies per compiled `data:` module, keeping each import small. */
const COMPILE_CHUNK = 100

/**
 * Compile one or more module bodies in a single generated module.
 * @param sources - Lowered bodies as the image holds them.
 * @returns One factory per source, in the same order.
 */
export async function importBodies(sources: readonly string[]): Promise<ModuleBody[]> {
  const parameters = MODULE_PARAMS.join(', ')
  const factories = sources.map((source, index) =>
    `export const m${index} = function (${parameters}) {\n${source}\n}`,
  ).join('\n')
  const defaults = sources.map((_, index) => `m${index}`).join(', ')
  const text = `${factories}\nexport default [${defaults}]\n`
  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(text)}`
  const namespace = await import(/* @vite-ignore */ url) as { default: ModuleBody[] }
  return namespace.default
}

/**
 * Compile every lowered body in the image ahead of the first require, so
 * module evaluation never builds code from strings at run time.
 *
 * A body that refuses to compile means the image was not lowered by the
 * packer; that fails loud through {@link fail}, naming the module and the
 * packer as the fix.
 * @param vfs - Image filesystem holding the lowered bodies.
 * @param root - Absolute root the image mounts at.
 * @param fail - Loader failure reporter, which never returns.
 * @returns One compiled factory per lowered body, keyed by absolute VFS path.
 */
export async function precompileImage(
  vfs: MemoryVfs,
  root: string,
  fail: (message: string) => never,
): Promise<Map<string, ModuleBody>> {
  const factories = new Map<string, ModuleBody>()
  const paths = collectModulePaths(vfs, root)
  for (let offset = 0; offset < paths.length; offset += COMPILE_CHUNK) {
    await compileRange(vfs, paths.slice(offset, offset + COMPILE_CHUNK), factories, fail)
  }
  return factories
}

/** Collect lowered-body paths, skipping the image's data-only subtrees. */
function collectModulePaths(vfs: MemoryVfs, root: string): string[] {
  const paths: string[] = []
  const visit = (directory: string): void => {
    for (const entry of vfs.readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!DATA_DIRECTORIES.has(child)) visit(child)
      } else if (entry.isFile() && /\.(js|cjs|mjs)$/.test(entry.name)) {
        paths.push(child)
      }
    }
  }
  visit(root)
  return paths
}

/**
 * Compile one batch, narrowing a batch-wide refusal to the module that caused
 * it by retrying each body alone.
 * @param vfs - Image filesystem holding the lowered bodies.
 * @param paths - Absolute VFS paths of the bodies in this batch.
 * @param factories - Destination map compiled bodies land in.
 * @param fail - Loader failure reporter, which never returns.
 */
async function compileRange(
  vfs: MemoryVfs,
  paths: readonly string[],
  factories: Map<string, ModuleBody>,
  fail: (message: string) => never,
): Promise<void> {
  const sources = paths.map(path => vfs.readFileSync(path, 'utf8') as string)
  const bodies = await importBodies(sources).then(
    compiled => compiled,
    () => compileIndividually(paths, sources, fail),
  )
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]
    const factory = bodies[index]
    if (path === undefined || factory === undefined) fail(`module ${String(paths[index])} produced no compiled body`)
    factories.set(path, factory)
  }
}

/**
 * Compile each body alone; the first refusal names its module and stops the
 * boot, because one unlowered body means the image was not packer-built.
 * @param vfs - Image filesystem holding the lowered bodies.
 * @param paths - Absolute VFS paths, parallel to {@link sources}.
 * @param sources - Lowered bodies as the image holds them.
 * @param fail - Loader failure reporter, which never returns.
 * @returns One factory per source, in the same order.
 */
async function compileIndividually(
  paths: readonly string[],
  sources: readonly string[],
  fail: (message: string) => never,
): Promise<ModuleBody[]> {
  const bodies: ModuleBody[] = []
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index]
    const source = sources[index]
    if (path === undefined || source === undefined) fail(`module ${String(path)} was not read`)
    const body = await importBodies([source]).then(
      compiled => compiled[0],
      (reason: Error) => {
        throw new Error(`${path} still carries module syntax, so the image was not lowered by the packer `
          + `(${reason.message}); rebuild the image`)
      },
    )
    if (body === undefined) fail(`${path} produced no compiled body`)
    bodies.push(body)
  }
  return bodies
}
