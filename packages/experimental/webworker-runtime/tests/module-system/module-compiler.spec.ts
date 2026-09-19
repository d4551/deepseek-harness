/**
 * Owning tests for generated `data:` compilation, leftover import reject arms,
 * image-path collection, and the missing-factory refuse.
 */
import { describe, expect, it } from 'vitest'
import {
  importBodies,
  precompileImage,
  requireCompiledBody,
} from '../../src/module-system/module-compiler.ts'
import type { ModuleBody } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import type { VfsDirent, VfsReadOptions } from '../../src/storage/types.ts'

function refuse(message: string): never {
  throw new Error(message)
}

/**
 * Close the generated factory wrapper so the leftover value is thrown while
 * the `data:` module evaluates, which is the import reject arm.
 * @param expression - Source text of the leftover Thrown.
 * @returns A body that makes `importBodies` reject with that value.
 */
function leftoverThrow(expression: string): string {
  return `}; throw ${expression}; {`
}

function seedModule(vfs: MemoryVfs, path: string, source: string): void {
  vfs.seed(path, source)
}

async function expectLeftoverRefuse(path: string, source: string, detail: string): Promise<void> {
  const vfs = new MemoryVfs()
  seedModule(vfs, path, source)
  await expect(precompileImage(vfs, '/dsh', refuse)).rejects.toThrow(
    `${path} still carries module syntax, so the image was not lowered by the packer `
    + `(${detail}); rebuild the image`,
  )
}

describe('importBodies', () => {
  it('returns one invokable factory per lowered body, including an empty batch', async () => {
    const empty = await importBodies([])
    expect(empty).toEqual([])
    const [factory] = await importBodies(['exports.ok = true'])
    const exports: Record<string, unknown> = {}
    factory!(exports, refuse as never, { exports }, '/dsh/ok.js', '/dsh', {
      url: 'file:///dsh/ok.js',
      resolve: specifier => specifier,
    }, {} as never)
    expect(exports.ok).toBe(true)
  })
})

describe('requireCompiledBody', () => {
  it('returns the factory and refuses a missing one', () => {
    const factory = (() => {}) as ModuleBody
    expect(requireCompiledBody('/dsh/ok.js', factory, refuse)).toBe(factory)
    expect(() => requireCompiledBody('/dsh/missing.js', undefined, refuse)).toThrow(
      'module /dsh/missing.js produced no compiled body',
    )
  })
})

describe('precompileImage', () => {
  it('compiles js, cjs, and mjs bodies and skips non-code names', async () => {
    const vfs = new MemoryVfs()
    seedModule(vfs, '/dsh/lib/ok.js', 'exports.kind = "js"')
    seedModule(vfs, '/dsh/lib/ok.cjs', 'exports.kind = "cjs"')
    seedModule(vfs, '/dsh/lib/ok.mjs', 'exports.kind = "mjs"')
    vfs.seed('/dsh/lib/notes.md', '# notes')
    vfs.seed('/dsh/lib/ok.ts', 'export {}')
    const factories = await precompileImage(vfs, '/dsh', refuse)
    expect([...factories.keys()].sort()).toEqual([
      '/dsh/lib/ok.cjs',
      '/dsh/lib/ok.js',
      '/dsh/lib/ok.mjs',
    ])
  })

  it('skips relative data-directory names when the walk root makes those names', async () => {
    const vfs = new MemoryVfs()
    seedModule(vfs, '/home/skip.js', 'exports.skip = true')
    seedModule(vfs, '/workspace/skip.js', 'exports.skip = true')
    seedModule(vfs, '/tmp/skip.js', 'exports.skip = true')
    seedModule(vfs, '/pkg/keep.js', 'exports.keep = true')
    const factories = await precompileImage(vfs, '.', refuse)
    expect([...factories.keys()]).toEqual(['pkg/keep.js'])
  })

  it('retries a mixed batch individually, keeps the earlier factory, then refuses the leftover', async () => {
    const vfs = new MemoryVfs()
    seedModule(vfs, '/dsh/a-good.js', 'exports.ok = true')
    seedModule(vfs, '/dsh/z-bad.js', leftoverThrow("'leftover string'"))
    await expect(precompileImage(vfs, '/dsh', refuse)).rejects.toThrow(
      '/dsh/z-bad.js still carries module syntax, so the image was not lowered by the packer '
      + '(leftover string); rebuild the image',
    )
  })

  it('recovers a batch whose combined exports collide after each body compiles alone', async () => {
    const vfs = new MemoryVfs()
    seedModule(vfs, '/dsh/a.js', '}; export const m1 = 1; {')
    seedModule(vfs, '/dsh/b.js', 'exports.ok = true')
    const factories = await precompileImage(vfs, '/dsh', refuse)
    expect([...factories.keys()].sort()).toEqual(['/dsh/a.js', '/dsh/b.js'])
  })

  it('names leftover module syntax through the import SyntaxError message', async () => {
    expect.assertions(1)
    await expectLeftoverRefuse('/dsh/esm.js', 'import x from "y"', "Unexpected identifier 'x'")
  })

  it('claims leftover Thrown reject values as product text', async () => {
    expect.assertions(10)
    const leftoverFn = function leftover() { /* leftover function Thrown */ }
    await expectLeftoverRefuse('/dsh/error.js', leftoverThrow('new Error("packer syntax")'), 'packer syntax')
    await expectLeftoverRefuse('/dsh/string.js', leftoverThrow("'leftover string'"), 'leftover string')
    await expectLeftoverRefuse('/dsh/number.js', leftoverThrow('7'), '7')
    await expectLeftoverRefuse('/dsh/boolean.js', leftoverThrow('false'), 'false')
    await expectLeftoverRefuse('/dsh/bigint.js', leftoverThrow('2n'), '2')
    await expectLeftoverRefuse('/dsh/symbol.js', leftoverThrow("Symbol.for('leftover')"), 'Symbol(leftover)')
    await expectLeftoverRefuse('/dsh/undefined.js', leftoverThrow('undefined'), 'undefined')
    await expectLeftoverRefuse('/dsh/null.js', leftoverThrow('null'), 'null')
    await expectLeftoverRefuse('/dsh/object.js', leftoverThrow('{ leftover: true }'), '[object Object]')
    await expectLeftoverRefuse('/dsh/function.js', leftoverThrow(leftoverFn.toString()), leftoverFn.toString())
  })

  it('refuses a utf8 read that is not text', async () => {
    class BytesVfs extends MemoryVfs {
      override readFileSync(_path: string, _options?: VfsReadOptions): string | Uint8Array {
        return new Uint8Array([1])
      }
    }
    const vfs = new BytesVfs()
    seedModule(vfs, '/dsh/bytes.js', 'exports.ok = true')
    await expect(precompileImage(vfs, '/dsh', refuse)).rejects.toThrow('module /dsh/bytes.js was not read')
  })

  it('skips directory entries that are neither files nor directories', async () => {
    class SocketVfs extends MemoryVfs {
      override readdirSync(directory: string, options?: { withFileTypes?: boolean }): string[] & VfsDirent[] {
        const names = ['socket']
        if (options?.withFileTypes !== true) return names as string[] & VfsDirent[]
        return [{
          name: 'socket',
          parentPath: directory,
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        }] as string[] & VfsDirent[]
      }
    }
    const vfs = new SocketVfs()
    vfs.seedDirectory('/dsh')
    const factories = await precompileImage(vfs, '/dsh', refuse)
    expect(factories.size).toBe(0)
  })

  it('compiles more than one chunk of lowered bodies', async () => {
    const vfs = new MemoryVfs()
    for (let index = 0; index < 101; index += 1) {
      const name = String(index).padStart(3, '0')
      seedModule(vfs, `/dsh/chunk-${name}.js`, `exports.n = ${String(index)}`)
    }
    const factories = await precompileImage(vfs, '/dsh', refuse)
    expect(factories.size).toBe(101)
  })
})
