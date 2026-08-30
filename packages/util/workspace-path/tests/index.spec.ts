import { describe, expect, it } from 'vitest'
import {
  abbreviateHomePath, resolveWorkspacePath, workspaceTitleOf,
} from '@deepseek-ai/dsh-util-workspace-path'

describe('Workspace path helpers', () => {
  it('resolves relative paths without changing absolute paths', () => {
    expect(resolveWorkspacePath('/w', 'src/a.ts')).toBe('/w/src/a.ts')
    expect(resolveWorkspacePath('/w/', '/abs/a.ts')).toBe('/abs/a.ts')
    expect(resolveWorkspacePath(undefined, 'src/a.ts')).toBe('src/a.ts')
    expect(resolveWorkspacePath('', 'src/a.ts')).toBe('src/a.ts')
    expect(resolveWorkspacePath('/w', 'C:\\x\\a.ts')).toBe('C:\\x\\a.ts')
    expect(resolveWorkspacePath('/w', '\\\\server\\share')).toBe('\\\\server\\share')
  })

  it('abbreviates only descendants of a POSIX home', () => {
    expect(abbreviateHomePath('/Users/u', '/Users/u')).toBe('~')
    expect(abbreviateHomePath('/Users/u/', '/Users/u')).toBe('~')
    expect(abbreviateHomePath('/Users/u/Documents/project', '/Users/u')).toBe('~/Documents/project')
    expect(abbreviateHomePath('/Users/u2/a.ts', '/Users/u')).toBe('/Users/u2/a.ts')
    expect(abbreviateHomePath('/Users/u/a.ts')).toBe('/Users/u/a.ts')
    expect(abbreviateHomePath('/Users/u/a.ts', '')).toBe('/Users/u/a.ts')
    expect(abbreviateHomePath('/etc/hosts', '/')).toBe('/etc/hosts')
    expect(abbreviateHomePath('C:\\Users\\u\\project', 'C:\\Users\\u')).toBe('C:\\Users\\u\\project')
    expect(abbreviateHomePath('\\\\server\\share\\u', '\\\\server\\share\\u'))
      .toBe('\\\\server\\share\\u')
  })

  it('reads the final path segment on both path styles', () => {
    expect(workspaceTitleOf('/work/project/')).toBe('project')
    expect(workspaceTitleOf('C:\\work\\project\\')).toBe('project')
    expect(workspaceTitleOf('/')).toBe('')
  })
})

describe('Workspace path separator and prefix handling', () => {
  it('treats a drive prefix as Windows only at the start of the path', () => {
    // Mid-path drive letters are ordinary segments, so the path stays relative.
    expect(resolveWorkspacePath('/w', 'x/C:/a.ts')).toBe('/w/x/C:/a.ts')
    expect(resolveWorkspacePath('/w', 'C:a.ts')).toBe('/w/C:a.ts')
  })

  it('collapses every trailing workspace separator and every leading path separator', () => {
    expect(resolveWorkspacePath('/w//', 'a.ts')).toBe('/w/a.ts')
    expect(resolveWorkspacePath('/w\\\\', 'a.ts')).toBe('/w/a.ts')
    expect(resolveWorkspacePath('/w', '\\/a.ts')).toBe('/w/a.ts')
    expect(resolveWorkspacePath('/w/', '\\a.ts')).toBe('/w/a.ts')
  })

  it('keeps a workspace root that carries no trailing separator intact', () => {
    expect(resolveWorkspacePath('/w', 'a.ts')).toBe('/w/a.ts')
  })

  it('abbreviates a home given with repeated trailing slashes', () => {
    expect(abbreviateHomePath('/Users/u/docs', '/Users/u//')).toBe('~/docs')
    expect(abbreviateHomePath('/Users/u//', '/Users/u')).toBe('~')
  })

  it('refuses to abbreviate against a root-only or empty home', () => {
    expect(abbreviateHomePath('/etc/hosts', '//')).toBe('/etc/hosts')
    expect(abbreviateHomePath('/etc/hosts', '/')).toBe('/etc/hosts')
  })

  it('reads the final segment through repeated and mixed trailing separators', () => {
    expect(workspaceTitleOf('/work/project//')).toBe('project')
    expect(workspaceTitleOf('/work/project/\\')).toBe('project')
    expect(workspaceTitleOf('//')).toBe('')
    expect(workspaceTitleOf('project')).toBe('project')
  })
})
