import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activeAtToken,
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  formatFileMention,
  WorkspaceFileSearch,
} from '../src/search.ts'

const fsControl = vi.hoisted(() => ({
  /** Absolute path whose `readdir` rejects; the injectable stand-in for chmod 0. */
  denyReaddir: undefined as string | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (async (path: unknown, ...rest: never[]) => {
      if (fsControl.denyReaddir !== undefined && String(path) === fsControl.denyReaddir) {
        throw Object.assign(new Error('EACCES: injected unreadable directory'), { code: 'EACCES' })
      }
      return (actual.readdir as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readdir,
  }
})

const searches: WorkspaceFileSearch[] = []
const roots: string[] = []
/** Permission-stripped directories; restored before cleanup can remove them. */
const locks: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-autocomplete-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, '.hidden'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'ignored-package'), { recursive: true })
  await writeFile(join(root, 'README.md'), 'readme')
  await writeFile(join(root, 'src', 'tui.spec.ts'), 'test')
  await writeFile(join(root, 'src', 'terminal-view.ts'), 'view')
  await writeFile(join(root, 'docs', 'design notes.md'), 'design')
  await writeFile(join(root, '.hidden', 'secret.txt'), 'hidden')
  await writeFile(join(root, 'node_modules', 'ignored-package', 'index.js'), 'ignored')
  try {
    await symlink(join(root, 'src', 'tui.spec.ts'), join(root, 'linked-test.ts'))
  } catch {
    // Windows may deny symlink creation without Developer Mode; the product
    // still skips every non-file/non-directory Dirent on platforms that expose one.
  }
  return root
}

function search(
  root: string | readonly string[],
  overrides: Partial<ConstructorParameters<typeof WorkspaceFileSearch>[1]> = {},
): WorkspaceFileSearch {
  const instance = new WorkspaceFileSearch(typeof root === 'string' ? [root] : root, {
    maxResults: overrides.maxResults ?? 20,
    maxEntries: overrides.maxEntries ?? 10_000,
    excludedDirectories: overrides.excludedDirectories ?? ['.git', 'node_modules'],
  })
  searches.push(instance)
  return instance
}

/** A bare workspace root holding exactly the given root-relative files. */
async function checkout(...files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-autocomplete-root-'))
  roots.push(root)
  for (const file of files) {
    const absolute = join(root, file)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, file)
  }
  return root
}

/** The mention text an additional root renders its candidates as. */
function mention(root: string, path: string): string {
  return join(root, path).replaceAll('\\', '/')
}

afterEach(async () => {
  for (const locked of locks.splice(0)) await chmod(locked, 0o700).catch(() => undefined)
  for (const instance of searches.splice(0)) instance.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('file-reference grammar', () => {
  it('recognizes boundary and quoted mentions without treating emails as references', () => {
    expect(activeAtToken('@src/tu', 7)).toEqual({ prefix: '@src/tu', query: 'src/tu', quoted: false })
    expect(activeAtToken('read @"docs/design n', 20)).toEqual({
      prefix: '@"docs/design n',
      query: 'docs/design n',
      quoted: true,
    })
    expect(activeAtToken('mail a@b.test', 13)).toBeUndefined()
    expect(activeAtToken('done @src/x" next', 17)).toBeUndefined()
  })

  it('formats files, directories, quotes, and rejects unsafe editor values', () => {
    expect(formatFileMention({ path: 'src/index.ts', kind: 'file' }, false)).toBe('@src/index.ts')
    expect(formatFileMention({ path: 'src', kind: 'directory' }, false)).toBe('@src/')
    expect(formatFileMention({ path: 'docs/design notes.md', kind: 'file' }, false))
      .toBe('@"docs/design notes.md"')
    expect(formatFileMention({ path: 'docs/design notes', kind: 'directory' }, false))
      .toBe('@"docs/design notes/')
    expect(formatFileMention({ path: 'README.md', kind: 'file' }, true)).toBe('@"README.md"')
    expect(formatFileMention({ path: 'bad\nname', kind: 'file' }, false)).toBeUndefined()
    expect(formatFileMention({ path: 'bad "name".md', kind: 'file' }, false)).toBeUndefined()
    expect(formatFileMention({ path: 'bad"name.md', kind: 'file' }, false)).toBeUndefined()
  })
})

describe('WorkspaceFileSearch', () => {
  it('lists live directory levels, descends, quotes spaces, and filters hidden/excluded entries', async () => {
    const root = await workspace()
    const files = search(root)
    const signal = new AbortController().signal

    expect(await files.list('', signal)).toEqual([
      { path: 'docs', kind: 'directory' },
      { path: 'src', kind: 'directory' },
      { path: 'README.md', kind: 'file' },
    ])
    expect(await files.list('src/', signal)).toEqual([
      { path: 'src/terminal-view.ts', kind: 'file' },
      { path: 'src/tui.spec.ts', kind: 'file' },
    ])
    expect(await files.list('src/ts', signal)).toEqual([
      { path: 'src/tui.spec.ts', kind: 'file' },
      { path: 'src/terminal-view.ts', kind: 'file' },
    ])
    expect(await files.list('docs/design n', signal)).toEqual([
      { path: 'docs/design notes.md', kind: 'file' },
    ])
    expect(await files.list('node_modules/', signal)).toEqual([])
    expect(await files.list('.hidden/', signal)).toEqual([
      { path: '.hidden/secret.txt', kind: 'file' },
    ])
    const absoluteSrc = `${join(root, 'src').replaceAll('\\', '/')}/`
    expect(await files.list(`${absoluteSrc}tui`, signal)).toEqual([
      { path: `${absoluteSrc}tui.spec.ts`, kind: 'file' },
      { path: `${absoluteSrc}terminal-view.ts`, kind: 'file' },
    ])
    expect(await files.list('~/.dsh-file-autocomplete-missing/', signal)).toEqual([])
    expect(await files.list('../', signal)).toEqual([])
    expect(await files.list('README.md/', signal)).toEqual([])
  })

  it('does not traverse directory symlinks during direct completion', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-file-autocomplete-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'outside-secret.txt'), 'secret')
    await symlink(
      outside,
      join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const files = search(root)
    const signal = new AbortController().signal

    expect(await files.list('escape/', signal)).toEqual([])
    expect(await files.list('escape/outside', signal)).toEqual([])
  })

  it('ranks basename and subsequence fuzzy matches across the bounded workspace index', async () => {
    const root = await workspace()
    await writeFile(join(root, 'src', 'tspc-helper.ts'), 'helper')
    const files = search(root, { maxResults: 2 })
    const signal = new AbortController().signal

    expect(await files.list('tspc', signal)).toEqual([
      { path: 'src/tspc-helper.ts', kind: 'file' },
      { path: 'src/tui.spec.ts', kind: 'file' },
    ])
    expect(await files.list('README.md', signal)).toEqual([
      { path: 'README.md', kind: 'file' },
    ])
    expect(await files.list('terminal', signal)).toEqual([
      { path: 'src/terminal-view.ts', kind: 'file' },
    ])
    expect(await files.list('secret', signal)).toEqual([])
    expect(await files.list('.hidden', signal)).toEqual([
      { path: '.hidden', kind: 'directory' },
      { path: '.hidden/secret.txt', kind: 'file' },
    ])
  })

  it('serves an invalidated index while its replacement builds, then swaps it in', async () => {
    const root = await workspace()
    const files = search(root)
    const signal = new AbortController().signal
    expect(await files.list('fresh-file', signal)).toEqual([])
    await writeFile(join(root, 'fresh-file.ts'), 'fresh')
    // No invalidation: the settled traversal is still the answer.
    expect(await files.list('fresh-file', signal)).toEqual([])
    files.invalidate()
    // The stale entries answer this query; the rebuild runs behind the caret.
    expect(await files.list('fresh-file', signal)).toEqual([])
    await vi.waitFor(async () => {
      expect(await files.list('fresh-file', signal)).toEqual([
        { path: 'fresh-file.ts', kind: 'file' },
      ])
    })
    files.dispose()
    expect(await files.list('fresh-file', signal)).toEqual([])
    files.dispose()
  })

  it('keeps the stale entries when the workspace root is unreadable, and retries once it returns', async () => {
    const root = await workspace()
    const files = search(root)
    const signal = new AbortController().signal
    expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }])

    // A root that vanishes under a live index: an unreadable branch costs its
    // own candidates, but an unreadable root must not be published as an
    // empty workspace over entries that are still good.
    await rm(root, { recursive: true, force: true })
    files.invalidate()
    expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }])
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }])

    // The failed attempt left the index stale, so its return is picked up
    // without waiting for another invalidation.
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'restored.ts'), 'restored')
    await vi.waitFor(async () => {
      expect(await files.list('restored', signal)).toEqual([{ path: 'restored.ts', kind: 'file' }])
    })
  })

  // chmod 0 can only deny directory reads on POSIX to a non-root owner:
  // Windows exposes no directory permission bits for readdir, and root
  // bypasses them. Where the fixture stays readable the sealed candidate is
  // indexed, so the unreadable-branch behavior is pinned on POSIX non-root.
  it.runIf(
    process.getuid !== undefined && process.getuid() !== 0,
  )('lets an unreadable subtree cost only its own candidates', async () => {
    const root = await workspace()
    const locked = join(root, 'locked')
    await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'sealed.ts'), 'sealed')
    await chmod(locked, 0o000)
    locks.push(locked)
    const files = search(root)
    const signal = new AbortController().signal

    // The branch itself yields nothing, and the rest of the tree still does.
    expect(await files.list('sealed', signal)).toEqual([])
    expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }])
    // The directory is still offered: only reading through it fails.
    expect(await files.list('locked', signal)).toEqual([{ path: 'locked', kind: 'directory' }])
  })

  // The chmod-0 fixture above cannot be built on Windows (no directory
  // permission bits) or as root (bits are bypassed). An injected readdir
  // failure keeps the unreadable-branch behavior covered on every platform.
  it('lets an injected readdir failure cost only its own candidates', async () => {
    const root = await workspace()
    const locked = join(root, 'locked')
    await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'sealed.ts'), 'sealed')
    fsControl.denyReaddir = locked
    try {
      const files = search(root)
      const signal = new AbortController().signal

      // The branch itself yields nothing, and the rest of the tree still does.
      expect(await files.list('sealed', signal)).toEqual([])
      expect(await files.list('README', signal)).toEqual([{ path: 'README.md', kind: 'file' }])
      // The directory is still offered: only reading through it fails.
      expect(await files.list('locked', signal)).toEqual([{ path: 'locked', kind: 'directory' }])
    } finally {
      fsControl.denyReaddir = undefined
    }
  })

  it('enforces the entry cap', async () => {
    const root = await workspace()
    const capped = search(root, { maxEntries: 2 })
    expect(await capped.list('README', new AbortController().signal)).toEqual([
      { path: 'README.md', kind: 'file' },
    ])
  })

  it('never traverses an excluded build output, so generated twins cannot outrank sources', async () => {
    const root = await workspace()
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'terminal-view.js'), 'built')
    const files = search(root, { excludedDirectories: [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES] })
    expect(await files.list('terminal-view', new AbortController().signal)).toEqual([
      { path: 'src/terminal-view.ts', kind: 'file' },
    ])
    expect(await files.list('dist/', new AbortController().signal)).toEqual([])
  })

  it('still offers a `lib` tree, where several ecosystems keep their sources', async () => {
    const root = await workspace()
    await mkdir(join(root, 'lib'), { recursive: true })
    await writeFile(join(root, 'lib', 'gem-entry.rb'), 'source')
    const files = search(root, { excludedDirectories: [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES] })
    expect(await files.list('gem-entry', new AbortController().signal)).toEqual([
      { path: 'lib/gem-entry.rb', kind: 'file' },
    ])
  })

  it('cancels individual callers, skips missing directories, and validates limits', async () => {
    const root = await workspace()
    expect(() => search(root, { maxResults: 0 })).toThrow('maxResults')
    expect(() => search(root, { maxEntries: 1.5 })).toThrow('maxEntries')
    expect(() => search(root, { excludedDirectories: ['nested/name'] })).toThrow('basenames')

    const files = search(root)
    expect(await files.list('missing/', new AbortController().signal)).toEqual([])

    const preAborted = new AbortController()
    preAborted.abort(new Error('pre-aborted'))
    await expect(files.list('tui', preAborted.signal)).rejects.toThrow('pre-aborted')

    files.invalidate()
    const running = new AbortController()
    const pending = files.list('tui', running.signal)
    running.abort(new Error('superseded'))
    await expect(pending).rejects.toThrow('superseded')

    files.invalidate()
    const nonErrorAbort = new AbortController()
    const nonErrorPending = files.list('tui', nonErrorAbort.signal)
    nonErrorAbort.abort('cancelled')
    await expect(nonErrorPending).rejects.toThrow('file search aborted')
  })
})

describe('WorkspaceFileSearch across multiple workspace roots', () => {
  it('reaches a file that exists only in an additional root, rendered absolute', async () => {
    const primary = await checkout('README.md', 'src/app.ts')
    const second = await checkout('service.ts')
    const files = search([primary, second])

    expect(await files.list('service', new AbortController().signal)).toEqual([
      { path: mention(second, 'service.ts'), kind: 'file' },
    ])
  })

  it('ranks a stronger additional-root match above primary-root matches within maxResults', async () => {
    const primary = await checkout('src/service.ts.bak', 'lib/service.tsx')
    const second = await checkout('service.ts')
    const files = search([primary, second], { maxResults: 1 })

    expect(await files.list('service.ts', new AbortController().signal)).toEqual([
      { path: mention(second, 'service.ts'), kind: 'file' },
    ])
  })

  it('scores the root-relative path, so a root prefix never decides a match', async () => {
    const primary = await checkout('README.md')
    const second = await checkout('service.ts')
    const files = search([primary, second])

    // Every additional-root candidate carries the temporary directory's own
    // path segments; matching them would offer the whole root for any query.
    expect(await files.list('autocomplete', new AbortController().signal)).toEqual([])
  })

  it('offers an additional root whose absolute path contains a dotted segment', async () => {
    const primary = await checkout('README.md')
    const container = await mkdtemp(join(tmpdir(), 'dsh-file-autocomplete-container-'))
    roots.push(container)
    const hidden = join(container, '.checkouts', 'service')
    await mkdir(hidden, { recursive: true })
    await writeFile(join(hidden, 'service.ts'), 'service')
    const files = search([primary, hidden])

    expect(await files.list('service', new AbortController().signal)).toEqual([
      { path: mention(hidden, 'service.ts'), kind: 'file' },
    ])
  })

  it('lists a relative directory level in every root that has one', async () => {
    const primary = await checkout('src/app.ts')
    const second = await checkout('src/service.ts')
    const files = search([primary, second])

    expect(await files.list('src/', new AbortController().signal)).toEqual([
      { path: 'src/app.ts', kind: 'file' },
      { path: mention(second, 'src/service.ts'), kind: 'file' },
    ])
  })

  it('orders a merged directory level by path, not by root', async () => {
    const primary = await checkout('src/service.ts')
    const second = await checkout('src/app.ts')
    const files = search([primary, second])

    expect(await files.list('src/', new AbortController().signal)).toEqual([
      { path: mention(second, 'src/app.ts'), kind: 'file' },
      { path: 'src/service.ts', kind: 'file' },
    ])
  })

  it('lists a directory level two roots both resolve exactly once', async () => {
    const primary = await checkout('nested/inner/file.ts')
    const nested = join(primary, 'nested')
    const files = search([primary, nested])

    expect(await files.list(`${mention(primary, 'nested')}/`, new AbortController().signal)).toEqual([
      { path: mention(nested, 'inner'), kind: 'directory' },
    ])
  })

  it('drills into an additional root through the absolute path it was offered as', async () => {
    const primary = await checkout('src/app.ts')
    const second = await checkout('src/service.ts')
    const files = search([primary, second])
    const secondSrc = `${mention(second, 'src')}/`

    expect(await files.list(`${secondSrc}serv`, new AbortController().signal)).toEqual([
      { path: `${secondSrc}service.ts`, kind: 'file' },
    ])
  })

  it('orders an identically named file primary root first', async () => {
    const primary = await checkout('README.md')
    const second = await checkout('README.md')
    const files = search([primary, second])

    expect(await files.list('README', new AbortController().signal)).toEqual([
      { path: 'README.md', kind: 'file' },
      { path: mention(second, 'README.md'), kind: 'file' },
    ])
  })

  it('spends the entry budget breadth-first, so a deep primary root cannot starve a later one', async () => {
    const primary = await checkout('deep/nested/leaf.ts')
    const second = await checkout('top.ts')
    const files = search([primary, second], { maxEntries: 2 })
    const signal = new AbortController().signal

    expect(await files.list('top', signal)).toEqual([
      { path: mention(second, 'top.ts'), kind: 'file' },
    ])
    expect(await files.list('leaf', signal)).toEqual([])
  })

  it('indexes a path two roots both reach once, under the root that reached it first', async () => {
    const primary = await checkout('nested/inner/file.ts')
    const nested = join(primary, 'nested')
    const files = search([primary, nested])

    expect(await files.list('file', new AbortController().signal)).toEqual([
      { path: mention(nested, 'inner/file.ts'), kind: 'file' },
    ])
  })

  it('keeps the stale entries when an additional root is unreadable, and retries once it returns', async () => {
    const primary = await checkout('README.md')
    const second = await checkout('service.ts')
    const files = search([primary, second])
    const signal = new AbortController().signal
    const secondService = { path: mention(second, 'service.ts'), kind: 'file' as const }
    expect(await files.list('service', signal)).toEqual([secondService])

    await writeFile(join(primary, 'fresh.ts'), 'fresh')
    fsControl.denyReaddir = second
    try {
      files.invalidate()
      // A root that cannot be read leaves the traversal without that root's
      // entries, so it must not publish a primary-only index over good ones.
      expect(await files.list('fresh', signal)).toEqual([])
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      expect(await files.list('service', signal)).toEqual([secondService])
    } finally {
      fsControl.denyReaddir = undefined
    }

    await vi.waitFor(async () => {
      expect(await files.list('fresh', signal)).toEqual([{ path: 'fresh.ts', kind: 'file' }])
    })
    expect(await files.list('service', signal)).toEqual([secondService])
  })

  it('rejects an empty root list instead of indexing nothing', () => {
    expect(() => search([])).toThrow('at least one workspace root')
  })
})
